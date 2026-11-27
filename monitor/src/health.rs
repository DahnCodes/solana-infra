//! Per-RPC liveness for `GET /health`, fed by ingestor heartbeats.

use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RpcHealth {
    pub url: String,
    pub last_slot: u64,
    pub lag_secs: i64,
    pub alive: bool,
}

/// Per source: (url, last slot, last heartbeat unix time).
type Entries = BTreeMap<String, (String, u64, Option<i64>)>;

#[derive(Clone)]
pub struct Health {
    timeout: i64,
    started: i64,
    inner: Arc<RwLock<Entries>>,
}

impl Health {
    /// `sources`: (name, url) in config order.
    pub fn new(sources: Vec<(String, String)>, timeout_secs: i64, now: i64) -> Self {
        let inner = sources
            .into_iter()
            .map(|(n, u)| (n, (u, 0, None)))
            .collect();
        Self {
            timeout: timeout_secs,
            started: now,
            inner: Arc::new(RwLock::new(inner)),
        }
    }

    pub fn beat(&self, source: &str, slot: u64, now: i64) {
        if let Some(e) = self.inner.write().unwrap().get_mut(source) {
            e.1 = e.1.max(slot);
            e.2 = Some(now);
        }
    }

    pub fn report(&self, now: i64) -> (bool, Vec<RpcHealth>) {
        let rpcs: Vec<RpcHealth> = self
            .inner
            .read()
            .unwrap()
            .values()
            .map(|(url, slot, seen)| {
                let lag = now - seen.unwrap_or(self.started);
                RpcHealth {
                    url: url.clone(),
                    last_slot: *slot,
                    lag_secs: lag,
                    alive: seen.is_some() && lag <= self.timeout,
                }
            })
            .collect();
        let ok = rpcs.iter().all(|r| r.alive);
        (ok, rpcs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn degraded_until_every_rpc_beats_and_after_one_goes_quiet() {
        let h = Health::new(
            vec![("rpc0".into(), "a".into()), ("rpc1".into(), "b".into())],
            30,
            0,
        );
        assert!(!h.report(1).0);
        h.beat("rpc0", 5, 1);
        h.beat("rpc1", 6, 1);
        let (ok, rpcs) = h.report(2);
        assert!(ok);
        assert_eq!(rpcs[1].last_slot, 6);
        h.beat("rpc0", 9, 40);
        let (ok, rpcs) = h.report(40);
        assert!(!ok);
        assert!(rpcs[0].alive && !rpcs[1].alive);
        assert_eq!(rpcs[1].lag_secs, 39);
    }
}
