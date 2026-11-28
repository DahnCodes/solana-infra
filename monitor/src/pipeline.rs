//! Ingest messages -> dedupe -> store -> detectors -> router (and the guardian bot).

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{broadcast, mpsc};

use crate::decode::{data_hash, token_account, BgEvent};
use crate::detectors::hold_request;
use crate::detectors::Detector;
use crate::event::{now_secs, ChainEvent, Observed, Signal};
use crate::health::Health;
use crate::ingest::{AccountKind, Ingest, Seen};
use crate::router::{Router, StreamMsg};
use crate::store::Store;

pub struct Pipeline {
    pub store: Store,
    pub protocol_id: i32,
    pub detectors: Vec<Box<dyn Detector>>,
    pub router: Router,
    pub seen: Arc<Seen>,
    pub health: Health,
    pub stream: broadcast::Sender<StreamMsg>,
    /// Every signal also goes to the guardian bot, if it runs.
    pub bot: Option<mpsc::Sender<Signal>>,
    /// Newest slot applied per watched account (drops stale/duplicate updates).
    last_slot: HashMap<String, u64>,
}

impl Pipeline {
    pub fn new(
        store: Store,
        protocol_id: i32,
        detectors: Vec<Box<dyn Detector>>,
        router: Router,
        seen: Arc<Seen>,
        health: Health,
        stream: broadcast::Sender<StreamMsg>,
    ) -> Self {
        Self {
            store,
            protocol_id,
            detectors,
            router,
            seen,
            health,
            stream,
            bot: None,
            last_slot: HashMap::new(),
        }
    }

    async fn detect(&mut self, ev: &Observed) {
        if !matches!(ev.event, ChainEvent::Heartbeat { .. }) {
            tracing::debug!(source = %ev.source, slot = ev.slot, event = ?ev.event, "observed");
        }
        let mut signals = vec![];
        for d in self.detectors.iter_mut() {
            signals.extend(d.observe(ev));
        }
        self.dispatch(signals).await;
    }

    async fn dispatch(&mut self, signals: Vec<Signal>) {
        for s in signals {
            if let Some(bot) = &self.bot {
                if bot.try_send(s.clone()).is_err() {
                    tracing::error!(dedupe_key = %s.dedupe_key, "guardian bot queue full or closed; signal not acted on");
                }
            }
            self.router.handle(s).await;
        }
    }

    async fn flow(&self, kind: &str, owner: &str, mint: &str, amount: u64, sig: &str) {
        if let Err(e) = self
            .store
            .insert_flow(self.protocol_id, kind, owner, mint, amount, Some(sig))
            .await
        {
            tracing::warn!(error = %e, "could not record flow");
        }
    }

    pub async fn handle(&mut self, msg: Ingest) {
        let now = now_secs();
        match msg {
            Ingest::Tx {
                source,
                signature,
                data,
            } => {
                if !self.seen.insert(&signature) {
                    return; // another RPC delivered it first
                }
                let obs = |event| Observed {
                    source: source.clone(),
                    signature: Some(signature.clone()),
                    slot: data.slot,
                    received_at: now,
                    event,
                };
                // Context first: who the withdrawing wallets are, what was deposited.
                for (wallet, first_seen, flagged_funder) in &data.wallets {
                    self.detect(&obs(ChainEvent::WalletProfile {
                        wallet: wallet.clone(),
                        first_seen: *first_seen,
                        flagged_funder: flagged_funder.clone(),
                    }))
                    .await;
                }
                for (owner, mint, vault, amount) in &data.deposits {
                    self.flow("deposit", owner, mint, *amount, &signature).await;
                    self.detect(&obs(ChainEvent::Deposit {
                        owner: owner.clone(),
                        mint: mint.clone(),
                        vault: vault.clone(),
                        amount: *amount,
                    }))
                    .await;
                }
                let is_claim = data
                    .events
                    .iter()
                    .any(|e| matches!(e, BgEvent::HoldResolved(r) if r.outcome == 0));
                for (i, e) in data.events.iter().cloned().enumerate() {
                    let json = e.data_json();
                    match self
                        .store
                        .insert_event(
                            self.protocol_id,
                            e.name(),
                            &signature,
                            i as u32,
                            data.slot,
                            data.block_time,
                            &json,
                        )
                        .await
                    {
                        Ok(Some(stored)) => {
                            let _ = self.stream.send(StreamMsg {
                                kind: "event",
                                data: serde_json::to_value(&stored).unwrap_or_default(),
                            });
                        }
                        Ok(None) => {}
                        Err(err) => tracing::warn!(error = %err, "could not store event"),
                    }
                    if let BgEvent::OutflowRecorded(o) = &e {
                        let kind = if is_claim { "claim" } else { "outflow" };
                        self.flow(
                            kind,
                            &o.owner.to_string(),
                            &o.mint.to_string(),
                            o.amount.0,
                            &signature,
                        )
                        .await;
                    } else if let Some(h) = hold_request(&e) {
                        self.flow("held", &h.owner, &h.mint, h.amount, &signature)
                            .await;
                    }
                    self.detect(&obs(ChainEvent::Breakglass(e))).await;
                }
                for (address, h) in &data.holds {
                    if let Err(err) = self.store.upsert_hold(self.protocol_id, address, h).await {
                        tracing::warn!(error = %err, "could not mirror hold");
                    }
                }
                for (address, p) in &data.pending {
                    if let Err(err) = self
                        .store
                        .upsert_pending(self.protocol_id, address, p)
                        .await
                    {
                        tracing::warn!(error = %err, "could not mirror pending change");
                    }
                }
            }
            Ingest::Account {
                source,
                pubkey,
                slot,
                data,
                kind,
            } => {
                if self
                    .last_slot
                    .get(&pubkey)
                    .is_some_and(|last| slot <= *last)
                {
                    return;
                }
                self.last_slot.insert(pubkey.clone(), slot);
                let event = match kind {
                    AccountKind::Vault => match token_account(&data) {
                        Some((mint, amount)) => ChainEvent::VaultBalance {
                            vault: pubkey,
                            mint: mint.to_string(),
                            amount,
                        },
                        None => {
                            tracing::warn!(account = %pubkey, "watched vault is not a token account");
                            return;
                        }
                    },
                    AccountKind::ProgramData { program } => ChainEvent::ProgramData {
                        program,
                        hash: data_hash(&data),
                    },
                };
                let ev = Observed {
                    source,
                    signature: None,
                    slot,
                    received_at: now,
                    event,
                };
                self.detect(&ev).await;
            }
            Ingest::Blocked {
                source,
                signature,
                slot,
                reason,
            } => {
                if !self.seen.insert(&signature) {
                    return;
                }
                let ev = Observed {
                    source,
                    signature: Some(signature),
                    slot,
                    received_at: now,
                    event: ChainEvent::Blocked { reason },
                };
                self.detect(&ev).await;
            }
            Ingest::Heartbeat { source, slot } => {
                self.health.beat(&source, slot, now);
                let ev = Observed {
                    source: source.clone(),
                    signature: None,
                    slot,
                    received_at: now,
                    event: ChainEvent::Heartbeat { source },
                };
                self.detect(&ev).await;
            }
        }
    }

    pub async fn tick(&mut self) {
        let now = now_secs();
        let mut signals = vec![];
        for d in self.detectors.iter_mut() {
            signals.extend(d.tick(now));
        }
        self.dispatch(signals).await;
    }
}
