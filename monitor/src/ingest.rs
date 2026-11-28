//! Ingestors: one per (RPC, websocket) pair, each on its own task, reconnecting
//! with backoff. Each one:
//! - `logsSubscribe` (processed) to the Breakglass program and to the protected
//!   program; for every successful transaction it fetches the transaction
//!   (confirmed) and decodes the Breakglass `emit_cpi!` events in its inner
//!   instructions, plus the PendingWithdrawal accounts those events mention;
//! - `accountSubscribe` (processed) to each vault token account and to both
//!   programs' ProgramData accounts, after reading their current state once;
//! - `slotSubscribe`, throttled to one heartbeat per second (liveness).
//!
//! Transactions are deduped by signature across ingestors (`Seen`): an
//! ingestor skips a signature the pipeline already accepted, and the pipeline
//! drops late duplicates.

use std::collections::{HashMap, HashSet, VecDeque};
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::stream::{select_all, BoxStream, StreamExt};
use solana_account_decoder_client_types::UiAccountEncoding;
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_client::rpc_client::GetConfirmedSignaturesForAddress2Config;
use solana_pubsub_client::nonblocking::pubsub_client::PubsubClient;
use solana_rpc_client_api::config::{
    RpcAccountInfoConfig, RpcTransactionConfig, RpcTransactionLogsConfig, RpcTransactionLogsFilter,
};
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Signature;
use solana_transaction_status_client_types::option_serializer::OptionSerializer;
use solana_transaction_status_client_types::{
    UiInstruction, UiTransactionEncoding, UiTransactionStatusMeta, UiTransactionTokenBalance,
};
use tokio::sync::mpsc;

use crate::decode::{decode_event, BgEvent, DecodeError, PendingConfig, PendingWithdrawal};

#[derive(Debug, Clone, PartialEq)]
pub enum AccountKind {
    Vault,
    ProgramData { program: String },
}

#[derive(Debug, Clone)]
pub enum Ingest {
    Tx {
        source: String,
        signature: String,
        data: TxData,
    },
    Account {
        source: String,
        pubkey: String,
        slot: u64,
        data: Vec<u8>,
        kind: AccountKind,
    },
    Heartbeat {
        source: String,
        slot: u64,
    },
}

/// Everything the monitor takes from one transaction.
#[derive(Debug, Clone, Default)]
pub struct TxData {
    pub slot: u64,
    pub block_time: Option<i64>,
    pub events: Vec<BgEvent>,
    /// PendingWithdrawal accounts the events mention (address, account).
    pub holds: Vec<(String, PendingWithdrawal)>,
    /// PendingConfig accounts the events mention (address, account).
    pub pending: Vec<(String, PendingConfig)>,
    /// Tokens moved into watched vaults: (owner, mint, vault, amount).
    pub deposits: Vec<(String, String, String, u64)>,
    /// Withdrawing wallets: (wallet, first seen, flagged funder).
    pub wallets: Vec<(String, Option<i64>, Option<String>)>,
}

/// A wallet's (first seen, flagged funder).
type Profile = (Option<i64>, Option<String>);

/// What to watch, shared by all ingestors.
pub struct Watch {
    pub breakglass: Pubkey,
    pub protected: Pubkey,
    /// (account, kind): vault token accounts and ProgramData accounts.
    pub accounts: Vec<(Pubkey, AccountKind)>,
    /// Mixer/bridge addresses for the fresh-address check.
    pub flagged_funders: Vec<Pubkey>,
    /// Wallet profiles already looked up (a wallet's oldest transaction never changes).
    profiles: Mutex<HashMap<Pubkey, Profile>>,
}

impl Watch {
    pub fn new(
        breakglass: &str,
        protected: &str,
        vaults: &[String],
        flagged_funders: &[String],
    ) -> anyhow::Result<Self> {
        let breakglass = Pubkey::from_str(breakglass)?;
        let protected = Pubkey::from_str(protected)?;
        let mut accounts = vec![];
        for v in vaults {
            accounts.push((Pubkey::from_str(v)?, AccountKind::Vault));
        }
        for p in [breakglass, protected] {
            let pd = solana_sdk::bpf_loader_upgradeable::get_program_data_address(&p);
            accounts.push((
                pd,
                AccountKind::ProgramData {
                    program: p.to_string(),
                },
            ));
        }
        Ok(Self {
            breakglass,
            protected,
            accounts,
            flagged_funders: flagged_funders
                .iter()
                .map(|f| Pubkey::from_str(f))
                .collect::<Result<_, _>>()?,
            profiles: Mutex::new(HashMap::new()),
        })
    }
}

/// Bounded set of signatures already accepted by the pipeline.
pub struct Seen {
    inner: Mutex<(HashSet<String>, VecDeque<String>)>,
    cap: usize,
}

impl Seen {
    pub fn new(cap: usize) -> Self {
        Self {
            inner: Mutex::new((HashSet::new(), VecDeque::new())),
            cap,
        }
    }
    pub fn contains(&self, s: &str) -> bool {
        self.inner.lock().unwrap().0.contains(s)
    }
    /// True if `s` is new.
    pub fn insert(&self, s: &str) -> bool {
        let mut g = self.inner.lock().unwrap();
        if !g.0.insert(s.to_string()) {
            return false;
        }
        g.1.push_back(s.to_string());
        if g.1.len() > self.cap {
            if let Some(old) = g.1.pop_front() {
                g.0.remove(&old);
            }
        }
        true
    }
}

pub fn spawn(
    source: String,
    rpc_url: String,
    ws_url: String,
    watch: Arc<Watch>,
    tx: mpsc::Sender<Ingest>,
    seen: Arc<Seen>,
) {
    tokio::spawn(async move {
        let mut backoff = Duration::from_secs(1);
        loop {
            let started = std::time::Instant::now();
            match run(&source, &rpc_url, &ws_url, &watch, &tx, &seen).await {
                Ok(()) => return, // pipeline gone: shutting down
                Err(e) => {
                    tracing::warn!(%source, error = %e, "ingestor disconnected; reconnecting")
                }
            }
            if started.elapsed() > Duration::from_secs(60) {
                backoff = Duration::from_secs(1);
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(30));
        }
    });
}

enum Item {
    Logs(String, bool),
    Slot(u64),
    Account(Pubkey, AccountKind, u64, Option<Vec<u8>>),
}

async fn run(
    source: &str,
    rpc_url: &str,
    ws_url: &str,
    watch: &Arc<Watch>,
    out: &mpsc::Sender<Ingest>,
    seen: &Arc<Seen>,
) -> anyhow::Result<()> {
    let rpc = Arc::new(RpcClient::new_with_commitment(
        rpc_url.to_string(),
        CommitmentConfig::confirmed(),
    ));
    let ps = PubsubClient::new(ws_url).await?;
    let processed = Some(CommitmentConfig::processed());

    let mut streams: Vec<BoxStream<'_, Item>> = vec![];
    for program in [watch.breakglass, watch.protected] {
        let (s, _unsub) = ps
            .logs_subscribe(
                RpcTransactionLogsFilter::Mentions(vec![program.to_string()]),
                RpcTransactionLogsConfig {
                    commitment: processed,
                },
            )
            .await?;
        streams.push(
            s.map(|r| Item::Logs(r.value.signature, r.value.err.is_none()))
                .boxed(),
        );
    }
    let (slots, _unsub) = ps.slot_subscribe().await?;
    streams.push(slots.map(|s| Item::Slot(s.slot)).boxed());
    let acct_cfg = RpcAccountInfoConfig {
        encoding: Some(UiAccountEncoding::Base64),
        commitment: processed,
        ..Default::default()
    };
    for (pk, kind) in &watch.accounts {
        let (s, _unsub) = ps.account_subscribe(pk, Some(acct_cfg.clone())).await?;
        let (pk, kind) = (*pk, kind.clone());
        streams.push(
            s.map(move |r| Item::Account(pk, kind.clone(), r.context.slot, r.value.data.decode()))
                .boxed(),
        );
    }
    tracing::info!(%source, %ws_url, subscriptions = streams.len(), "ingestor subscribed");

    // Current state of watched accounts (subscriptions only report changes).
    for (pk, kind) in &watch.accounts {
        match rpc
            .get_account_with_commitment(pk, CommitmentConfig::processed())
            .await
        {
            Ok(r) => {
                if let Some(acc) = r.value {
                    let msg = Ingest::Account {
                        source: source.into(),
                        pubkey: pk.to_string(),
                        slot: r.context.slot,
                        data: acc.data,
                        kind: kind.clone(),
                    };
                    if out.send(msg).await.is_err() {
                        return Ok(());
                    }
                } else {
                    tracing::warn!(%source, account = %pk, "watched account does not exist");
                }
            }
            Err(e) => anyhow::bail!("reading {pk}: {e}"),
        }
    }

    let mut merged = select_all(streams);
    let mut last_beat = std::time::Instant::now() - Duration::from_secs(10);
    while let Some(item) = merged.next().await {
        match item {
            Item::Logs(sig, ok) => {
                if !ok || seen.contains(&sig) {
                    continue;
                }
                let (rpc, watch, out, seen, source) = (
                    rpc.clone(),
                    watch.clone(),
                    out.clone(),
                    seen.clone(),
                    source.to_string(),
                );
                tokio::spawn(async move {
                    match fetch(&rpc, &sig, &watch, &seen).await {
                        Ok(Some(data)) => {
                            let _ = out
                                .send(Ingest::Tx {
                                    source,
                                    signature: sig,
                                    data,
                                })
                                .await;
                        }
                        Ok(None) => {}
                        Err(e) => {
                            tracing::warn!(%source, signature = %sig, error = %e, "could not fetch transaction")
                        }
                    }
                });
            }
            Item::Slot(slot) => {
                if last_beat.elapsed() >= Duration::from_secs(1) {
                    last_beat = std::time::Instant::now();
                    if out
                        .send(Ingest::Heartbeat {
                            source: source.into(),
                            slot,
                        })
                        .await
                        .is_err()
                    {
                        return Ok(());
                    }
                }
            }
            Item::Account(pk, kind, slot, data) => {
                let Some(data) = data else { continue };
                if out
                    .send(Ingest::Account {
                        source: source.into(),
                        pubkey: pk.to_string(),
                        slot,
                        data,
                        kind,
                    })
                    .await
                    .is_err()
                {
                    return Ok(());
                }
            }
        }
    }
    anyhow::bail!("subscription stream ended")
}

/// Fetch a transaction (retrying until it's confirmed) and decode its events.
async fn fetch(
    rpc: &RpcClient,
    sig: &str,
    watch: &Watch,
    seen: &Seen,
) -> anyhow::Result<Option<TxData>> {
    let signature = Signature::from_str(sig)?;
    let cfg = RpcTransactionConfig {
        encoding: Some(UiTransactionEncoding::Base64),
        commitment: Some(CommitmentConfig::confirmed()),
        max_supported_transaction_version: Some(0),
    };
    let mut tx = None;
    for _ in 0..60 {
        if seen.contains(sig) {
            return Ok(None); // another ingestor got it first
        }
        match rpc.get_transaction_with_config(&signature, cfg).await {
            Ok(t) => {
                tx = Some(t);
                break;
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(250)).await,
        }
    }
    let tx = tx.ok_or_else(|| anyhow::anyhow!("not confirmed after 15s"))?;
    let Some(meta) = tx.transaction.meta.as_ref() else {
        return Ok(None);
    };
    if meta.err.is_some() {
        return Ok(None); // failed transactions emit nothing
    }
    let vtx = tx
        .transaction
        .transaction
        .decode()
        .ok_or_else(|| anyhow::anyhow!("undecodable transaction"))?;
    let mut keys: Vec<Pubkey> = vtx.message.static_account_keys().to_vec();
    if let OptionSerializer::Some(loaded) = &meta.loaded_addresses {
        for k in loaded.writable.iter().chain(loaded.readonly.iter()) {
            keys.push(Pubkey::from_str(k)?);
        }
    }

    let mut events = vec![];
    if let OptionSerializer::Some(groups) = &meta.inner_instructions {
        for group in groups {
            for ix in &group.instructions {
                let UiInstruction::Compiled(c) = ix else {
                    continue;
                };
                if keys.get(c.program_id_index as usize) != Some(&watch.breakglass) {
                    continue;
                }
                let data = bs58::decode(&c.data).into_vec()?;
                match decode_event(&data) {
                    Some(Ok(e)) => events.push(e),
                    Some(Err(DecodeError::UnknownEvent(d))) => {
                        tracing::error!(signature = %sig, disc = ?d, "unknown Breakglass event: is the monitor out of date?")
                    }
                    Some(Err(e)) => {
                        tracing::error!(signature = %sig, error = ?e, "malformed Breakglass event")
                    }
                    None => {}
                }
            }
        }
    }

    let mut hold_keys: Vec<Pubkey> = vec![];
    let mut change_keys: Vec<Pubkey> = vec![];
    let mut owners: Vec<Pubkey> = vec![];
    for e in &events {
        let (hold, owner) = match e {
            BgEvent::LargeWithdrawalQueued(x) => (Some(x.hold), Some(x.owner)),
            BgEvent::LimitHoldQueued(x) => (Some(x.hold), Some(x.owner)),
            BgEvent::WithdrawalScreenQueued(x) => (Some(x.hold), Some(x.owner)),
            BgEvent::HoldFrozen(x) => (Some(x.hold), None),
            BgEvent::HoldResolved(x) => (Some(x.hold), None),
            BgEvent::OutflowRecorded(x) => (None, Some(x.owner)),
            BgEvent::ConfigChangeProposed(x) => (Some(x.change), None),
            BgEvent::ConfigChangeExecuted(x) => (Some(x.change), None),
            BgEvent::ConfigChangeVetoed(x) => (Some(x.change), None),
            BgEvent::ConfigChangeCancelled(x) => (Some(x.change), None),
            _ => continue,
        };
        let is_change = matches!(
            e,
            BgEvent::ConfigChangeProposed(_)
                | BgEvent::ConfigChangeExecuted(_)
                | BgEvent::ConfigChangeVetoed(_)
                | BgEvent::ConfigChangeCancelled(_)
        );
        if let Some(h) = hold {
            let pk = Pubkey::new_from_array(h.0);
            let list = if is_change {
                &mut change_keys
            } else {
                &mut hold_keys
            };
            if !list.contains(&pk) {
                list.push(pk);
            }
        }
        if let Some(o) = owner {
            let pk = Pubkey::new_from_array(o.0);
            if !owners.contains(&pk) {
                owners.push(pk);
            }
        }
    }

    let mut data = TxData {
        slot: tx.slot,
        block_time: tx.block_time,
        ..Default::default()
    };
    for pk in hold_keys {
        if let Some(acc) = account(rpc, &pk).await {
            if let Some(h) = PendingWithdrawal::decode(&acc) {
                data.holds.push((pk.to_string(), h));
            }
        }
    }
    for pk in change_keys {
        if let Some(acc) = account(rpc, &pk).await {
            if let Some(p) = PendingConfig::decode(&acc) {
                data.pending.push((pk.to_string(), p));
            }
        }
    }
    for pk in owners {
        let (first_seen, funder) = profile(rpc, &pk, watch).await;
        data.wallets.push((pk.to_string(), first_seen, funder));
    }
    data.deposits = deposits(meta, &keys, watch);
    data.events = events;
    Ok(Some(data))
}

async fn account(rpc: &RpcClient, pk: &Pubkey) -> Option<Vec<u8>> {
    rpc.get_account_with_commitment(pk, CommitmentConfig::confirmed())
        .await
        .ok()?
        .value
        .map(|a| a.data)
}

/// Pages of signatures read to find a wallet's oldest transaction. A wallet
/// with more history than this is judged by the oldest one found, which is
/// still recent only for a very busy new wallet (it stays "fresh": fail closed).
const PROFILE_PAGES: usize = 3;

/// (first seen, flagged funder) for a wallet. `(None, None)` if the lookup failed.
async fn profile(rpc: &RpcClient, wallet: &Pubkey, watch: &Watch) -> (Option<i64>, Option<String>) {
    if let Some(p) = watch.profiles.lock().unwrap().get(wallet).cloned() {
        return p;
    }
    let mut before = None;
    let mut oldest = None;
    for _ in 0..PROFILE_PAGES {
        let cfg = GetConfirmedSignaturesForAddress2Config {
            before,
            until: None,
            limit: Some(1000),
            commitment: Some(CommitmentConfig::confirmed()),
        };
        let page = match rpc
            .get_signatures_for_address_with_config(wallet, cfg)
            .await
        {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(%wallet, error = %e, "wallet lookup failed; treating it as unverified");
                return (None, None);
            }
        };
        let Some(last) = page.last().cloned() else {
            break;
        };
        let full = page.len() == 1000;
        before = Signature::from_str(&last.signature).ok();
        oldest = Some(last);
        if !full {
            break;
        }
    }
    let Some(oldest) = oldest else {
        return (None, None);
    };
    let mut funder = None;
    if !watch.flagged_funders.is_empty() {
        let cfg = RpcTransactionConfig {
            encoding: Some(UiTransactionEncoding::Base64),
            commitment: Some(CommitmentConfig::confirmed()),
            max_supported_transaction_version: Some(0),
        };
        let Ok(sig) = Signature::from_str(&oldest.signature) else {
            return (None, None);
        };
        match rpc.get_transaction_with_config(&sig, cfg).await {
            Ok(t) => {
                let keys = t
                    .transaction
                    .transaction
                    .decode()
                    .map(|v| v.message.static_account_keys().to_vec())
                    .unwrap_or_default();
                funder = watch
                    .flagged_funders
                    .iter()
                    .find(|f| keys.contains(f))
                    .map(|f| f.to_string());
            }
            Err(_) => return (None, None),
        }
    }
    let result = (oldest.block_time, funder);
    watch
        .profiles
        .lock()
        .unwrap()
        .insert(*wallet, result.clone());
    result
}

/// Tokens that moved into a watched vault in this transaction, attributed to
/// the owner of the token account that lost the same mint.
fn deposits(
    meta: &UiTransactionStatusMeta,
    keys: &[Pubkey],
    watch: &Watch,
) -> Vec<(String, String, String, u64)> {
    let (OptionSerializer::Some(pre), OptionSerializer::Some(post)) =
        (&meta.pre_token_balances, &meta.post_token_balances)
    else {
        return vec![];
    };
    let amount = |list: &[UiTransactionTokenBalance], idx: u8| -> u64 {
        list.iter()
            .find(|b| b.account_index == idx)
            .and_then(|b| b.ui_token_amount.amount.parse().ok())
            .unwrap_or(0)
    };
    let mut out = vec![];
    for (vault, kind) in &watch.accounts {
        if *kind != AccountKind::Vault {
            continue;
        }
        let Some(vi) = keys.iter().position(|k| k == vault) else {
            continue;
        };
        let vi = vi as u8;
        let Some(mint) = post
            .iter()
            .find(|b| b.account_index == vi)
            .map(|b| b.mint.clone())
        else {
            continue;
        };
        let (before, after) = (amount(pre, vi), amount(post, vi));
        if after <= before {
            continue;
        }
        let payer = post
            .iter()
            .filter(|b| b.account_index != vi && b.mint == mint)
            .map(|b| {
                (
                    b,
                    amount(pre, b.account_index).saturating_sub(amount(post, b.account_index)),
                )
            })
            .filter(|(_, dec)| *dec > 0)
            .max_by_key(|(_, dec)| *dec);
        let owner = match payer {
            Some((b, _)) => match &b.owner {
                OptionSerializer::Some(o) => o.clone(),
                _ => continue,
            },
            None => continue,
        };
        out.push((owner, mint, vault.to_string(), after - before));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seen_is_bounded_and_dedupes() {
        let s = Seen::new(2);
        assert!(s.insert("a"));
        assert!(!s.insert("a"));
        assert!(s.insert("b"));
        assert!(s.insert("c"));
        assert!(!s.contains("a"), "evicted");
        assert!(s.contains("c"));
    }

    #[test]
    fn watch_includes_both_program_data_accounts() {
        let w = Watch::new(
            "AiMhNgDgXLQ68FhZrYczUiGxDxDeDxNFDTurqNFPP5kB",
            "2orgNn8kfHVQi8EMxa86zntq8BbwQefXPtpZiQTfgPyn",
            &["11111111111111111111111111111111".into()],
            &[],
        )
        .unwrap();
        assert_eq!(w.accounts.len(), 3);
        assert_eq!(w.accounts[0].1, AccountKind::Vault);
        assert!(matches!(w.accounts[2].1, AccountKind::ProgramData { .. }));
    }
}
