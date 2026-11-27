//! Signals -> incidents -> alerts.
//!
//! - One incident per root cause (`Signal::dedupe_key`). Later signals with the
//!   same key attach to it; they page again only if the severity rises, or if
//!   new Critical evidence arrives after an ack (the incident reopens).
//! - Routing per severity (`[alerts] routes`).
//! - Unacked Critical incidents re-page every `critical_repage_secs` and are
//!   marked ESCALATED after `escalate_after_secs`.
//! - Alerts are sent before anything waits on the database, and a database
//!   error never drops a page: it goes out without an incident number.

use std::time::Duration;

use serde::Serialize;
use tokio::sync::broadcast;

use crate::config::AlertConfig;
use crate::event::{Severity, Signal};
use crate::sinks::{Alert, Sinks};
use crate::store::{Incident, Store};

/// What `GET /stream` sends.
#[derive(Debug, Clone, Serialize)]
pub struct StreamMsg {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub data: serde_json::Value,
}

#[derive(Clone)]
pub struct Router {
    store: Store,
    protocol_id: i32,
    protocol: String,
    cfg: AlertConfig,
    sinks: Sinks,
    stream: broadcast::Sender<StreamMsg>,
}

impl Router {
    pub fn new(
        store: Store,
        protocol_id: i32,
        protocol: String,
        cfg: AlertConfig,
        sinks: Sinks,
        stream: broadcast::Sender<StreamMsg>,
    ) -> Self {
        Self {
            store,
            protocol_id,
            protocol,
            cfg,
            sinks,
            stream,
        }
    }

    fn alert(&self, s: &Signal, incident_id: Option<i64>, repage: u32, escalated: bool) -> Alert {
        Alert {
            incident_id,
            protocol: self.protocol.clone(),
            severity: s.severity,
            detector: s.detector.to_string(),
            title: s.title.clone(),
            detail: s.detail.clone(),
            actions: s.actions.clone(),
            signature: s.signature.clone(),
            tx_link: s
                .signature
                .as_ref()
                .map(|sig| self.cfg.explorer_tx_url.replace("{signature}", sig)),
            repage,
            escalated,
        }
    }

    fn publish(&self, inc: &Incident) {
        let _ = self.stream.send(StreamMsg {
            kind: "incident",
            data: serde_json::to_value(inc).unwrap_or_default(),
        });
    }

    /// Send to every routed sink and record each attempt. Runs in the
    /// background so a slow sink never stalls ingestion.
    fn page(&self, alert: Alert) {
        for name in self.cfg.sinks_for(alert.severity) {
            let Some(sink) = self.sinks.get(&name).cloned() else {
                continue;
            };
            let store = self.store.clone();
            let alert = alert.clone();
            tokio::spawn(async move {
                let res = tokio::time::timeout(Duration::from_secs(15), sink.send(&alert)).await;
                let err = match res {
                    Ok(Ok(())) => None,
                    Ok(Err(e)) => Some(e.to_string()),
                    Err(_) => Some("timed out".to_string()),
                };
                if let Some(e) = &err {
                    tracing::error!(sink = sink.name(), error = %e, "alert delivery failed");
                }
                if let Err(e) = store
                    .record_alert(
                        alert.incident_id,
                        sink.name(),
                        err.is_none(),
                        err.as_deref(),
                    )
                    .await
                {
                    tracing::warn!(error = %e, "could not record alert");
                }
            });
        }
    }

    pub async fn handle(&self, s: Signal) {
        let found = self
            .store
            .active_incident(self.protocol_id, &s.dedupe_key)
            .await;
        match found {
            Ok(Some(inc)) => {
                let raise = s.severity > inc.sev();
                let reopen = inc.status == "acked" && s.severity == Severity::Critical;
                let res = self
                    .store
                    .attach(
                        inc.num_id(),
                        s.signature.as_deref(),
                        raise.then_some((s.severity, s.title.as_str())),
                        reopen,
                    )
                    .await;
                if let Err(e) = res {
                    tracing::warn!(error = %e, "could not attach to incident");
                }
                if raise || reopen {
                    self.page(self.alert(&s, Some(inc.num_id()), 0, false));
                }
                if let Ok(Some(updated)) = self.store.incident(inc.num_id()).await {
                    self.publish(&updated);
                }
            }
            Ok(None) => {
                match self
                    .store
                    .create_incident(
                        self.protocol_id,
                        s.detector,
                        s.severity,
                        &s.title,
                        &s.dedupe_key,
                        s.signature.as_deref(),
                    )
                    .await
                {
                    Ok(inc) => {
                        self.page(self.alert(&s, Some(inc.num_id()), 0, false));
                        self.publish(&inc);
                    }
                    Err(e) => {
                        tracing::error!(error = %e, "could not create incident; paging without one");
                        self.page(self.alert(&s, None, 0, false));
                    }
                }
            }
            Err(e) => {
                tracing::error!(error = %e, "store unavailable; paging without an incident");
                self.page(self.alert(&s, None, 0, false));
            }
        }
    }

    /// Re-page unacked Critical incidents. Call every few seconds.
    pub async fn tick(&self) {
        let due = match self
            .store
            .due_for_repage(self.protocol_id, self.cfg.critical_repage_secs)
            .await
        {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!(error = %e, "repage check failed");
                return;
            }
        };
        for (inc, age) in due {
            let escalated = inc.escalated || age >= self.cfg.escalate_after_secs as i64;
            let s = Signal {
                detector: "router",
                severity: Severity::Critical,
                title: inc.title.clone(),
                detail: format!("still unacknowledged after {age}s"),
                actions: format!("Acknowledge: POST /incidents/{}/ack", inc.id),
                signature: inc.signatures.last().cloned(),
                dedupe_key: inc.dedupe_key.clone(),
            };
            let mut alert = self.alert(&s, Some(inc.num_id()), inc.page_count as u32, escalated);
            alert.detector = inc.detector.clone();
            self.page(alert);
            if let Err(e) = self.store.mark_paged(inc.num_id(), escalated).await {
                tracing::warn!(error = %e, "could not mark incident paged");
            }
        }
    }
}
