//! Alert sinks: stdout, Telegram, signed webhook. PagerDuty is a stub that
//! refuses to start, so a config can't silently rely on it.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use hmac::{Hmac, Mac};
use serde::Serialize;
use sha2::Sha256;

use crate::event::Severity;

/// One page about one incident.
#[derive(Debug, Clone, Serialize)]
pub struct Alert {
    pub incident_id: Option<i64>,
    pub protocol: String,
    pub severity: Severity,
    pub detector: String,
    pub title: String,
    pub detail: String,
    pub actions: String,
    pub signature: Option<String>,
    pub tx_link: Option<String>,
    /// 0 for the first page, then 1, 2, ... for re-pages.
    pub repage: u32,
    pub escalated: bool,
}

impl Alert {
    fn prefix(&self) -> String {
        let mut p = format!("[{}]", self.severity.as_str().to_uppercase());
        if self.escalated {
            p.push_str("[ESCALATED]");
        }
        if self.repage > 0 {
            p.push_str(&format!("[re-page #{}]", self.repage));
        }
        p
    }

    /// One line, for stdout and logs.
    pub fn line(&self) -> String {
        let mut s = format!(
            "{} {} | {} | {}",
            self.prefix(),
            self.detector,
            self.protocol,
            self.title
        );
        if !self.detail.is_empty() {
            s.push_str(&format!(" | {}", self.detail));
        }
        if let Some(sig) = &self.signature {
            s.push_str(&format!(" | tx {sig}"));
        }
        if let Some(id) = self.incident_id {
            s.push_str(&format!(" | incident #{id}"));
        }
        s
    }

    /// Multi-line, for chat.
    pub fn text(&self) -> String {
        let mut s = format!("{} {}\n{}", self.prefix(), self.protocol, self.title);
        if !self.detail.is_empty() {
            s.push_str(&format!("\n{}", self.detail));
        }
        if let Some(link) = &self.tx_link {
            s.push_str(&format!("\ntx: {link}"));
        }
        s.push_str(&format!("\nactions: {}", self.actions));
        if let Some(id) = self.incident_id {
            s.push_str(&format!(
                "\nincident #{id} ({}); ack: POST /incidents/{id}/ack",
                self.detector
            ));
        }
        s
    }
}

#[async_trait]
pub trait AlertSink: Send + Sync {
    fn name(&self) -> &'static str;
    async fn send(&self, alert: &Alert) -> anyhow::Result<()>;
}

pub struct StdoutSink;

#[async_trait]
impl AlertSink for StdoutSink {
    fn name(&self) -> &'static str {
        "stdout"
    }
    async fn send(&self, a: &Alert) -> anyhow::Result<()> {
        println!("{}", a.line());
        Ok(())
    }
}

pub struct TelegramSink {
    client: reqwest::Client,
    api_base: String,
    token: String,
    chat_id: String,
}

impl TelegramSink {
    pub fn new(api_base: String, token: String, chat_id: String) -> Self {
        Self {
            client: http_client(),
            api_base,
            token,
            chat_id,
        }
    }
}

#[async_trait]
impl AlertSink for TelegramSink {
    fn name(&self) -> &'static str {
        "telegram"
    }
    async fn send(&self, a: &Alert) -> anyhow::Result<()> {
        let url = format!("{}/bot{}/sendMessage", self.api_base, self.token);
        let res = self
            .client
            .post(url)
            .json(&serde_json::json!({ "chat_id": self.chat_id, "text": a.text(), "disable_web_page_preview": true }))
            .send()
            .await?;
        anyhow::ensure!(
            res.status().is_success(),
            "telegram returned {}",
            res.status()
        );
        Ok(())
    }
}

/// POSTs the alert as JSON. Headers:
/// `X-Breakglass-Timestamp: <unix secs>` and
/// `X-Breakglass-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>`.
/// Receivers should recompute the HMAC and reject stale timestamps (replay).
pub struct WebhookSink {
    client: reqwest::Client,
    url: String,
    secret: Vec<u8>,
}

impl WebhookSink {
    pub fn new(url: String, secret: String) -> Self {
        Self {
            client: http_client(),
            url,
            secret: secret.into_bytes(),
        }
    }
}

pub fn webhook_signature(secret: &[u8], timestamp: i64, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("any key length");
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b".");
    mac.update(body);
    format!("sha256={}", hex::encode(mac.finalize().into_bytes()))
}

#[async_trait]
impl AlertSink for WebhookSink {
    fn name(&self) -> &'static str {
        "webhook"
    }
    async fn send(&self, a: &Alert) -> anyhow::Result<()> {
        let body = serde_json::to_vec(a)?;
        let ts = crate::event::now_secs();
        let res = self
            .client
            .post(&self.url)
            .header("content-type", "application/json")
            .header("x-breakglass-timestamp", ts.to_string())
            .header(
                "x-breakglass-signature",
                webhook_signature(&self.secret, ts, &body),
            )
            .body(body)
            .send()
            .await?;
        anyhow::ensure!(
            res.status().is_success(),
            "webhook returned {}",
            res.status()
        );
        Ok(())
    }
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("reqwest client")
}

pub type Sinks = HashMap<String, Arc<dyn AlertSink>>;

fn env(name: &str) -> anyhow::Result<String> {
    match std::env::var(name) {
        Ok(v) if !v.trim().is_empty() => Ok(v),
        _ => anyhow::bail!("{name} must be set (monitor/.env) to use this sink"),
    }
}

/// Build the enabled sinks. Fails fast on a missing secret or an unknown sink.
pub fn build(names: &[String]) -> anyhow::Result<Sinks> {
    let mut out: Sinks = HashMap::new();
    for n in names {
        let sink: Arc<dyn AlertSink> = match n.as_str() {
            "stdout" => Arc::new(StdoutSink),
            "telegram" => Arc::new(TelegramSink::new(
                std::env::var("TELEGRAM_API_URL")
                    .unwrap_or_else(|_| "https://api.telegram.org".into()),
                env("TELEGRAM_BOT_TOKEN")?,
                env("TELEGRAM_CHAT_ID")?,
            )),
            "webhook" => Arc::new(WebhookSink::new(
                env("WEBHOOK_URL")?,
                env("WEBHOOK_SECRET")?,
            )),
            "pagerduty" => anyhow::bail!(
                "the pagerduty sink is a stub (not implemented yet): remove it from [alerts] sinks"
            ),
            other => anyhow::bail!("unknown sink '{other}'"),
        };
        out.insert(n.clone(), sink);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::State, http::HeaderMap, routing::post, Router};
    use std::sync::Mutex;

    fn alert() -> Alert {
        Alert {
            incident_id: Some(7),
            protocol: "test-vault".into(),
            severity: Severity::Critical,
            detector: "pause_trip".into(),
            title: "LimitTripped: cap hit".into(),
            detail: "900/1000".into(),
            actions: "unpause".into(),
            signature: Some("SIG".into()),
            tx_link: Some("https://explorer/tx/SIG".into()),
            repage: 2,
            escalated: true,
        }
    }

    #[test]
    fn text_carries_link_actions_and_incident() {
        let a = alert();
        assert!(a.line().starts_with(
            "[CRITICAL][ESCALATED][re-page #2] pause_trip | test-vault | LimitTripped"
        ));
        assert!(a.line().contains("tx SIG"));
        let t = a.text();
        assert!(t.contains("tx: https://explorer/tx/SIG"));
        assert!(t.contains("actions: unpause"));
        assert!(t.contains("incident #7"));
    }

    type Seen = Arc<Mutex<Vec<(HeaderMap, Vec<u8>)>>>;

    async fn mock() -> (String, Seen) {
        let seen: Seen = Arc::default();
        let app = Router::new()
            .route(
                "/{*path}",
                post(
                    |State(s): State<Seen>, h: HeaderMap, body: axum::body::Bytes| async move {
                        s.lock().unwrap().push((h, body.to_vec()));
                        "ok"
                    },
                ),
            )
            .with_state(seen.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), seen)
    }

    #[tokio::test]
    async fn webhook_is_signed_over_timestamp_and_body() {
        let (url, seen) = mock().await;
        WebhookSink::new(format!("{url}/hook"), "s3cret".into())
            .send(&alert())
            .await
            .unwrap();
        let (h, body) = seen.lock().unwrap()[0].clone();
        let ts: i64 = h["x-breakglass-timestamp"]
            .to_str()
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(
            h["x-breakglass-signature"].to_str().unwrap(),
            webhook_signature(b"s3cret", ts, &body)
        );
        assert_ne!(
            h["x-breakglass-signature"].to_str().unwrap(),
            webhook_signature(b"wrong", ts, &body)
        );
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["severity"], "critical");
        assert_eq!(json["incident_id"], 7);
    }

    #[tokio::test]
    async fn telegram_posts_to_the_bot_api() {
        let (url, seen) = mock().await;
        TelegramSink::new(url, "TOKEN".into(), "42".into())
            .send(&alert())
            .await
            .unwrap();
        let (_, body) = seen.lock().unwrap()[0].clone();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["chat_id"], "42");
        assert!(json["text"].as_str().unwrap().contains("LimitTripped"));
    }

    #[test]
    fn pagerduty_stub_and_unknown_sinks_refuse_to_start() {
        assert!(build(&["pagerduty".into()]).is_err());
        assert!(build(&["sms".into()]).is_err());
        assert!(build(&["stdout".into()]).is_ok());
    }
}
