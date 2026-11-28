//! Guardian bot: turns signals into guardian actions, within the on-chain limits.
//!
//! - It holds ONLY the guardian key, behind `GuardianSigner` (a file key in
//!   local dev; a KMS/HSM signer implements the same trait later).
//! - Pause: on a Critical from `balance_delta` alone, or Criticals from 2
//!   different detectors within `critical_window_secs`, it pauses
//!   `pause_scopes` for `pause_secs`. Liveness doesn't count (blindness isn't
//!   evidence of an exploit).
//! - Freeze: a signal from a `freeze_on` detector naming a held withdrawal
//!   freezes it (`freeze_held`). Clean holds are left to release on their own.
//! - Rate limit: at most `max_actions_per_minute` on-chain actions.
//! - Every attempt goes to the `actions` table with its outcome; on-chain
//!   errors (GuardianCooldown, PauseBudgetExhausted, ...) are logged by name
//!   and never crash or hot-loop the bot.

use std::collections::{HashSet, VecDeque};
use std::str::FromStr;
use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use sha2::{Digest, Sha256};
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::instruction::{AccountMeta, Instruction, InstructionError};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signature, Signer};
use solana_sdk::transaction::{Transaction, TransactionError};
use tokio::sync::mpsc;

use crate::config::BotConfig;
use crate::event::{now_secs, Severity, Signal};
use crate::store::Store;

// ---- signer -------------------------------------------------------------------

#[async_trait]
pub trait GuardianSigner: Send + Sync {
    fn pubkey(&self) -> Pubkey;
    async fn sign(&self, message: &[u8]) -> anyhow::Result<Signature>;
}

/// A keypair file (local dev). Never logged or exposed.
pub struct FileSigner(Keypair);

impl FileSigner {
    pub fn load(path: &str) -> anyhow::Result<Self> {
        let bytes: Vec<u8> = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        Ok(Self(Keypair::from_bytes(&bytes).map_err(|e| {
            anyhow::anyhow!("bad keypair file {path}: {e}")
        })?))
    }
}

#[async_trait]
impl GuardianSigner for FileSigner {
    fn pubkey(&self) -> Pubkey {
        self.0.pubkey()
    }
    async fn sign(&self, message: &[u8]) -> anyhow::Result<Signature> {
        Ok(self.0.sign_message(message))
    }
}

// ---- policy (pure) ------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Pause {
        scopes_mask: u64,
        secs: i64,
        reason: u16,
        why: String,
        triggered_by: Vec<String>,
    },
    Freeze {
        hold: String,
        why: String,
        triggered_by: Vec<String>,
    },
}

/// Detectors whose Criticals never trigger a pause.
const NOT_EVIDENCE: [&str; 2] = ["liveness", "router"];
/// After a pause attempt (successful or not), wait this long before another.
const PAUSE_RETRY_SECS: i64 = 60;

pub struct Policy {
    cfg: BotConfig,
    criticals: VecDeque<(i64, &'static str, String)>,
    paused_until: i64,
    last_pause_attempt: Option<i64>,
    frozen: HashSet<String>,
    recent_actions: VecDeque<i64>,
}

impl Policy {
    pub fn new(cfg: BotConfig) -> Self {
        Self {
            cfg,
            criticals: VecDeque::new(),
            paused_until: 0,
            last_pause_attempt: None,
            frozen: HashSet::new(),
            recent_actions: VecDeque::new(),
        }
    }

    fn mask(&self) -> u64 {
        self.cfg
            .pause_scopes
            .iter()
            .fold(0u64, |m, s| m | (1u64 << s))
    }

    pub fn on_signal(&mut self, s: &Signal, now: i64) -> Vec<Action> {
        let mut out = vec![];
        if s.severity == Severity::Critical && !NOT_EVIDENCE.contains(&s.detector) {
            self.criticals.push_back((now, s.detector, s.title.clone()));
            while self
                .criticals
                .front()
                .is_some_and(|(t, _, _)| now - *t > self.cfg.critical_window_secs)
            {
                self.criticals.pop_front();
            }
            let detectors: Vec<String> = {
                let mut d: Vec<String> = self
                    .criticals
                    .iter()
                    .map(|(_, d, _)| d.to_string())
                    .collect();
                d.sort();
                d.dedup();
                d
            };
            let trigger = if s.detector == "balance_delta" {
                Some("unexplained vault outflow (balance_delta)".to_string())
            } else if detectors.len() >= 2 {
                Some(format!(
                    "Critical signals from {} detectors",
                    detectors.len()
                ))
            } else {
                None
            };
            let retry_ok = self
                .last_pause_attempt
                .is_none_or(|t| now - t >= PAUSE_RETRY_SECS);
            if let Some(why) = trigger {
                if now >= self.paused_until && retry_ok {
                    self.last_pause_attempt = Some(now);
                    out.push(Action::Pause {
                        scopes_mask: self.mask(),
                        secs: self.cfg.pause_secs,
                        reason: self.cfg.pause_reason,
                        why: format!("{why}: {}", s.title),
                        triggered_by: if s.detector == "balance_delta" {
                            vec![s.detector.to_string()]
                        } else {
                            detectors
                        },
                    });
                }
            }
        }
        if self.cfg.freeze_on.iter().any(|d| d == s.detector) {
            if let Some(hold) = &s.subject.hold {
                if self.frozen.insert(hold.clone()) {
                    out.push(Action::Freeze {
                        hold: hold.clone(),
                        why: format!("{}: {}", s.detector, s.title),
                        triggered_by: vec![s.detector.to_string()],
                    });
                }
            }
        }
        out
    }

    /// Record a successful pause so the bot doesn't re-pause what it already paused.
    pub fn paused(&mut self, until: i64) {
        self.paused_until = self.paused_until.max(until);
    }

    /// Take a rate-limit slot, or refuse.
    pub fn allow(&mut self, now: i64) -> bool {
        while self.recent_actions.front().is_some_and(|t| now - *t >= 60) {
            self.recent_actions.pop_front();
        }
        if self.recent_actions.len() as u32 >= self.cfg.max_actions_per_minute {
            return false;
        }
        self.recent_actions.push_back(now);
        true
    }
}

// ---- instructions ---------------------------------------------------------------

fn disc(name: &str) -> [u8; 8] {
    Sha256::digest(format!("global:{name}").as_bytes())[..8]
        .try_into()
        .expect("8 bytes")
}

pub struct Accounts {
    pub program: Pubkey,
    pub config: Pubkey,
    pub pause_state: Pubkey,
    pub event_authority: Pubkey,
}

impl Accounts {
    pub fn new(breakglass: Pubkey, protected: Pubkey) -> Self {
        let (config, _) =
            Pubkey::find_program_address(&[b"config", protected.as_ref()], &breakglass);
        let (pause_state, _) =
            Pubkey::find_program_address(&[b"pause", config.as_ref()], &breakglass);
        let (event_authority, _) =
            Pubkey::find_program_address(&[b"__event_authority"], &breakglass);
        Self {
            program: breakglass,
            config,
            pause_state,
            event_authority,
        }
    }

    /// `pause(scopes, duration, reason)` signed by the guardian.
    pub fn pause_ix(
        &self,
        guardian: &Pubkey,
        scopes: u64,
        duration: i64,
        reason: u16,
    ) -> Instruction {
        let (ledger, _) = Pubkey::find_program_address(
            &[b"gledger", self.config.as_ref(), guardian.as_ref()],
            &self.program,
        );
        let mut data = disc("pause").to_vec();
        data.extend(scopes.to_le_bytes());
        data.extend(duration.to_le_bytes());
        data.extend(reason.to_le_bytes());
        Instruction {
            program_id: self.program,
            accounts: vec![
                AccountMeta::new(*guardian, true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new(self.pause_state, false),
                AccountMeta::new(ledger, false),
                AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
                AccountMeta::new_readonly(self.event_authority, false),
                AccountMeta::new_readonly(self.program, false),
            ],
            data,
        }
    }

    /// `freeze_held()` signed by the guardian.
    pub fn freeze_ix(&self, guardian: &Pubkey, hold: &Pubkey) -> Instruction {
        Instruction {
            program_id: self.program,
            accounts: vec![
                AccountMeta::new_readonly(*guardian, true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new(*hold, false),
                AccountMeta::new_readonly(self.event_authority, false),
                AccountMeta::new_readonly(self.program, false),
            ],
            data: disc("freeze_held").to_vec(),
        }
    }
}

/// Breakglass error names by code, from the committed IDL.
pub fn error_name(code: u32) -> Option<&'static str> {
    static T: OnceLock<Vec<(u32, String)>> = OnceLock::new();
    let t = T.get_or_init(|| {
        let idl: serde_json::Value =
            serde_json::from_str(include_str!("../../clients/ts/idl/breakglass.json"))
                .expect("committed IDL");
        idl["errors"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|e| {
                        (
                            e["code"].as_u64().unwrap_or(0) as u32,
                            e["name"].as_str().unwrap_or("").to_string(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    });
    t.iter().find(|(c, _)| *c == code).map(|(_, n)| n.as_str())
}

fn describe(e: &solana_client::client_error::ClientError) -> String {
    match e.get_transaction_error() {
        Some(TransactionError::InstructionError(_, InstructionError::Custom(code))) => {
            match error_name(code) {
                Some(name) => format!("{name} ({code})"),
                None => format!("custom program error {code}"),
            }
        }
        Some(other) => other.to_string(),
        None => e.to_string(),
    }
}

// ---- executor -------------------------------------------------------------------

pub struct Bot {
    policy: Policy,
    signer: Arc<dyn GuardianSigner>,
    accounts: Accounts,
    rpcs: Vec<RpcClient>,
    store: Store,
    protocol_id: i32,
}

impl Bot {
    pub fn new(
        cfg: BotConfig,
        signer: Arc<dyn GuardianSigner>,
        accounts: Accounts,
        rpc_urls: &[String],
        store: Store,
        protocol_id: i32,
    ) -> Self {
        let rpcs = rpc_urls
            .iter()
            .map(|u| RpcClient::new_with_commitment(u.clone(), CommitmentConfig::confirmed()))
            .collect();
        Self {
            policy: Policy::new(cfg),
            signer,
            accounts,
            rpcs,
            store,
            protocol_id,
        }
    }

    pub fn guardian(&self) -> Pubkey {
        self.signer.pubkey()
    }

    /// Fails if the bot's key isn't a guardian of this protocol's config.
    pub async fn check_guardian(&self) -> anyhow::Result<()> {
        for rpc in &self.rpcs {
            if let Ok(acc) = rpc.get_account(&self.accounts.config).await {
                // ProtocolConfig: disc(8) version(1) bump(1) protected(32) admin(32) guardians(vec)
                let d = &acc.data;
                anyhow::ensure!(d.len() >= 78, "config account too short");
                let n = u32::from_le_bytes(d[74..78].try_into()?) as usize;
                let me = self.guardian();
                let found = (0..n).any(|i| d.get(78 + i * 32..110 + i * 32) == Some(me.as_ref()));
                anyhow::ensure!(
                    found,
                    "bot key {me} is not a guardian of config {}",
                    self.accounts.config
                );
                return Ok(());
            }
        }
        anyhow::bail!(
            "could not read config {} from any RPC",
            self.accounts.config
        )
    }

    /// Runs until the signal channel closes. Never returns an error.
    pub async fn run(mut self, mut rx: mpsc::Receiver<Signal>) {
        tracing::info!(guardian = %self.guardian(), "guardian bot running");
        while let Some(s) = rx.recv().await {
            let now = now_secs();
            for action in self.policy.on_signal(&s, now) {
                self.execute(action, now).await;
            }
        }
    }

    async fn execute(&mut self, action: Action, now: i64) {
        let guardian = self.guardian();
        let (kind, target, why, triggered_by, ix, pause_until) = match &action {
            Action::Pause {
                scopes_mask,
                secs,
                reason,
                why,
                triggered_by,
            } => (
                "pause",
                format!("scopes {scopes_mask:#x} for {secs}s"),
                why.clone(),
                triggered_by.clone(),
                self.accounts
                    .pause_ix(&guardian, *scopes_mask, *secs, *reason),
                Some(now + secs),
            ),
            Action::Freeze {
                hold,
                why,
                triggered_by,
            } => {
                let Ok(pk) = Pubkey::from_str(hold) else {
                    tracing::error!(%hold, "bad hold address in signal");
                    return;
                };
                (
                    "freeze",
                    hold.clone(),
                    why.clone(),
                    triggered_by.clone(),
                    self.accounts.freeze_ix(&guardian, &pk),
                    None,
                )
            }
        };
        let (signature, error) = if !self.policy.allow(now) {
            (
                None,
                Some("rate limited: too many bot actions this minute".to_string()),
            )
        } else {
            match self.send(ix).await {
                Ok(sig) => (Some(sig.to_string()), None),
                Err(e) => (None, Some(e)),
            }
        };
        match &error {
            None => {
                tracing::info!(%kind, %target, signature = signature.as_deref().unwrap_or(""), "guardian bot action ok");
                if let Some(until) = pause_until {
                    self.policy.paused(until);
                }
            }
            Some(e) => tracing::warn!(%kind, %target, error = %e, "guardian bot action failed"),
        }
        if let Err(e) = self
            .store
            .insert_action(
                self.protocol_id,
                kind,
                &target,
                &why,
                &triggered_by,
                signature.as_deref(),
                error.is_none(),
                error.as_deref(),
            )
            .await
        {
            tracing::error!(error = %e, "could not log bot action");
        }
    }

    /// Sign and send through the first RPC that works.
    async fn send(&self, ix: Instruction) -> Result<Signature, String> {
        let mut last = "no RPC configured".to_string();
        for rpc in &self.rpcs {
            let blockhash = match rpc.get_latest_blockhash().await {
                Ok(b) => b,
                Err(e) => {
                    last = e.to_string();
                    continue;
                }
            };
            let mut tx =
                Transaction::new_with_payer(std::slice::from_ref(&ix), Some(&self.guardian()));
            tx.message.recent_blockhash = blockhash;
            let sig = match self.signer.sign(&tx.message_data()).await {
                Ok(s) => s,
                Err(e) => return Err(format!("signer: {e}")),
            };
            tx.signatures = vec![sig];
            match rpc.send_and_confirm_transaction(&tx).await {
                Ok(s) => return Ok(s),
                Err(e) => {
                    let d = describe(&e);
                    // A program error is final; a transport error tries the next RPC.
                    if e.get_transaction_error().is_some() {
                        return Err(d);
                    }
                    last = d;
                }
            }
        }
        Err(last)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::Subject;

    fn cfg() -> BotConfig {
        BotConfig {
            enabled: true,
            max_actions_per_minute: 3,
            ..BotConfig::default()
        }
    }

    fn sig(detector: &'static str, severity: Severity, hold: Option<&str>) -> Signal {
        Signal {
            detector,
            severity,
            title: "t".into(),
            detail: String::new(),
            actions: String::new(),
            signature: None,
            dedupe_key: "k".into(),
            subject: Subject {
                hold: hold.map(String::from),
                ..Default::default()
            },
        }
    }

    #[test]
    fn balance_delta_alone_pauses() {
        let mut p = Policy::new(cfg());
        let out = p.on_signal(&sig("balance_delta", Severity::Critical, None), 100);
        assert!(matches!(
            &out[..],
            [Action::Pause {
                scopes_mask: 2,
                secs: 3600,
                reason: 100,
                ..
            }]
        ));
    }

    #[test]
    fn two_independent_criticals_pause_one_does_not() {
        let mut p = Policy::new(cfg());
        assert!(p
            .on_signal(&sig("pause_trip", Severity::Critical, None), 100)
            .is_empty());
        assert!(
            p.on_signal(&sig("pause_trip", Severity::Critical, None), 101)
                .is_empty(),
            "same detector twice"
        );
        assert!(
            p.on_signal(&sig("liveness", Severity::Critical, None), 102)
                .is_empty(),
            "liveness isn't evidence"
        );
        assert!(p
            .on_signal(&sig("pause_trip", Severity::High, None), 103)
            .is_empty());
        let out = p.on_signal(&sig("program_upgrade", Severity::Critical, None), 104);
        match &out[..] {
            [Action::Pause { triggered_by, .. }] => assert_eq!(
                triggered_by,
                &vec!["pause_trip".to_string(), "program_upgrade".to_string()]
            ),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn criticals_outside_the_window_dont_combine() {
        let mut p = Policy::new(cfg());
        p.on_signal(&sig("pause_trip", Severity::Critical, None), 0);
        assert!(p
            .on_signal(&sig("program_upgrade", Severity::Critical, None), 601)
            .is_empty());
    }

    #[test]
    fn no_repeated_pauses_while_paused_or_right_after_an_attempt() {
        let mut p = Policy::new(cfg());
        assert_eq!(
            p.on_signal(&sig("balance_delta", Severity::Critical, None), 100)
                .len(),
            1
        );
        assert!(
            p.on_signal(&sig("balance_delta", Severity::Critical, None), 130)
                .is_empty(),
            "retry backoff"
        );
        p.paused(100 + 3600);
        assert!(
            p.on_signal(&sig("balance_delta", Severity::Critical, None), 500)
                .is_empty(),
            "our pause still runs"
        );
        assert_eq!(
            p.on_signal(&sig("balance_delta", Severity::Critical, None), 3701)
                .len(),
            1
        );
    }

    #[test]
    fn flagged_holds_are_frozen_once_and_others_are_not() {
        let mut p = Policy::new(cfg());
        let out = p.on_signal(&sig("fresh_address", Severity::High, Some("H1")), 1);
        assert!(matches!(&out[..], [Action::Freeze { hold, .. }] if hold == "H1"));
        assert!(
            p.on_signal(&sig("deposit_history", Severity::High, Some("H1")), 2)
                .is_empty(),
            "already frozen"
        );
        assert!(
            p.on_signal(&sig("large_withdrawal", Severity::High, Some("H2")), 3)
                .is_empty(),
            "not a screening detector"
        );
        assert!(
            p.on_signal(&sig("fresh_address", Severity::High, None), 4)
                .is_empty(),
            "nothing to freeze"
        );
    }

    #[test]
    fn rate_limit_per_minute() {
        let mut p = Policy::new(cfg());
        assert!(p.allow(0) && p.allow(1) && p.allow(2));
        assert!(!p.allow(30));
        assert!(p.allow(60));
    }

    /// Our hand-built instructions match the committed IDL: discriminator,
    /// account order and writable/signer flags.
    #[test]
    fn instructions_match_idl() {
        let idl: serde_json::Value =
            serde_json::from_str(include_str!("../../clients/ts/idl/breakglass.json")).unwrap();
        let a = Accounts::new(Pubkey::new_unique(), Pubkey::new_unique());
        let g = Pubkey::new_unique();
        for (name, ix) in [
            ("pause", a.pause_ix(&g, 2, 60, 100)),
            ("freeze_held", a.freeze_ix(&g, &Pubkey::new_unique())),
        ] {
            let spec = idl["instructions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|i| i["name"] == name)
                .unwrap();
            let d: Vec<u8> = spec["discriminator"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b.as_u64().unwrap() as u8)
                .collect();
            assert_eq!(&ix.data[..8], &d[..], "{name} discriminator");
            let accts = spec["accounts"].as_array().unwrap();
            assert_eq!(accts.len(), ix.accounts.len(), "{name} account count");
            for (meta, want) in ix.accounts.iter().zip(accts) {
                assert_eq!(
                    meta.is_writable,
                    want["writable"].as_bool().unwrap_or(false),
                    "{name}.{} writable",
                    want["name"]
                );
                assert_eq!(
                    meta.is_signer,
                    want["signer"].as_bool().unwrap_or(false),
                    "{name}.{} signer",
                    want["name"]
                );
            }
        }
        // pause args: scopes u64, duration i64, reason u16
        assert_eq!(a.pause_ix(&g, 2, 60, 100).data.len(), 8 + 8 + 8 + 2);
    }

    #[test]
    fn error_names_come_from_the_idl() {
        assert_eq!(error_name(6007), Some("GuardianCooldown"));
        assert_eq!(error_name(6008), Some("PauseBudgetExhausted"));
        assert_eq!(error_name(1), None);
    }
}
