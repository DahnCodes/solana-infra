//! Ingest messages -> dedupe -> store -> detectors -> router.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::broadcast;

use crate::decode::{data_hash, token_account};
use crate::detectors::Detector;
use crate::event::{now_secs, ChainEvent, Observed};
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
        for s in signals {
            self.router.handle(s).await;
        }
    }

    pub async fn handle(&mut self, msg: Ingest) {
        let now = now_secs();
        match msg {
            Ingest::Tx {
                source,
                signature,
                slot,
                block_time,
                events,
                holds,
            } => {
                if !self.seen.insert(&signature) {
                    return; // another RPC delivered it first
                }
                for (i, e) in events.into_iter().enumerate() {
                    let data = e.data_json();
                    match self
                        .store
                        .insert_event(
                            self.protocol_id,
                            e.name(),
                            &signature,
                            i as u32,
                            slot,
                            block_time,
                            &data,
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
                    let ev = Observed {
                        source: source.clone(),
                        signature: Some(signature.clone()),
                        slot,
                        received_at: now,
                        event: ChainEvent::Breakglass(e),
                    };
                    self.detect(&ev).await;
                }
                for (address, h) in holds {
                    if let Err(err) = self.store.upsert_hold(self.protocol_id, &address, &h).await {
                        tracing::warn!(error = %err, "could not mirror hold");
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
        for s in signals {
            self.router.handle(s).await;
        }
    }
}
