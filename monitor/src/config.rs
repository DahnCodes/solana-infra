use anyhow::Context;
use serde::Deserialize;
use std::path::Path;

use crate::event::Severity;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub network: Network,
    pub protocol: Protocol,
    pub detectors: DetectorConfig,
    pub alerts: AlertConfig,
    #[serde(default)]
    pub api: ApiConfig,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Network {
    /// One ingestor per (rpc_urls[i], ws_urls[i]) pair. Use 2+ independent providers.
    pub rpc_urls: Vec<String>,
    pub ws_urls: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Protocol {
    pub name: String,
    pub breakglass_program: String,
    pub protected_program: String,
    /// The protocol's vault token accounts (balance-delta detector).
    #[serde(default)]
    pub vault_token_accounts: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DetectorConfig {
    pub window_warning_pct: u8,
    pub window_high_pct: u8,
    pub heartbeat_timeout_secs: u64,
    /// Unexplained vault drop (base units) tolerated before alerting.
    #[serde(default)]
    pub balance_tolerance: u64,
    /// How long a drop may stay unexplained (events arrive after account updates).
    #[serde(default = "default_balance_grace")]
    pub balance_grace_secs: u64,
}

fn default_balance_grace() -> u64 {
    15
}

#[derive(Debug, Clone, Deserialize)]
pub struct AlertConfig {
    /// Enabled sinks: "stdout", "telegram", "webhook" ("pagerduty" is a stub).
    pub sinks: Vec<String>,
    /// Unacked Critical incidents are re-paged this often.
    pub critical_repage_secs: u64,
    /// ...and marked ESCALATED after this long unacked.
    #[serde(default = "default_escalate")]
    pub escalate_after_secs: u64,
    /// Transaction link template; `{signature}` is replaced.
    #[serde(default = "default_explorer")]
    pub explorer_tx_url: String,
    #[serde(default)]
    pub routes: Routes,
}

fn default_escalate() -> u64 {
    300
}

fn default_explorer() -> String {
    "https://explorer.solana.com/tx/{signature}?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899".into()
}

/// Which sinks get which severity. Sinks not enabled in `sinks` are skipped.
/// Defaults: Critical and High go to every enabled sink, Warning and Info to
/// chat only (stdout, telegram).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct Routes {
    pub critical: Option<Vec<String>>,
    pub high: Option<Vec<String>>,
    pub warning: Option<Vec<String>>,
    pub info: Option<Vec<String>>,
}

impl AlertConfig {
    pub fn sinks_for(&self, sev: Severity) -> Vec<String> {
        let chat = || vec!["stdout".to_string(), "telegram".to_string()];
        let route = match sev {
            Severity::Critical => self
                .routes
                .critical
                .clone()
                .unwrap_or_else(|| self.sinks.clone()),
            Severity::High => self
                .routes
                .high
                .clone()
                .unwrap_or_else(|| self.sinks.clone()),
            Severity::Warning => self.routes.warning.clone().unwrap_or_else(chat),
            Severity::Info => self.routes.info.clone().unwrap_or_else(chat),
        };
        route
            .into_iter()
            .filter(|s| self.sinks.contains(s))
            .collect()
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ApiConfig {
    #[serde(default = "default_bind")]
    pub bind: String,
    /// Allowed CORS origins. Empty: same-origin only.
    #[serde(default)]
    pub cors_origins: Vec<String>,
}

impl Default for ApiConfig {
    fn default() -> Self {
        Self {
            bind: default_bind(),
            cors_origins: vec![],
        }
    }
}

fn default_bind() -> String {
    "127.0.0.1:8080".into()
}

impl Config {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("reading config {}", path.display()))?;
        let cfg: Config = toml::from_str(&raw).context("parsing config")?;
        cfg.validate()?;
        Ok(cfg)
    }

    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            !self.network.rpc_urls.is_empty(),
            "need at least one rpc_url"
        );
        anyhow::ensure!(
            self.network.rpc_urls.len() == self.network.ws_urls.len(),
            "rpc_urls and ws_urls must pair up (same length)"
        );
        anyhow::ensure!(
            self.detectors.window_warning_pct < self.detectors.window_high_pct,
            "window_warning_pct must be below window_high_pct"
        );
        Ok(())
    }

    /// Ingestor names, matching `rpc_urls` order.
    pub fn sources(&self) -> Vec<String> {
        (0..self.network.rpc_urls.len())
            .map(|i| format!("rpc{i}"))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn example_config_parses() {
        let raw = include_str!("../config.example.toml");
        let cfg: Config = toml::from_str(raw).unwrap();
        cfg.validate().unwrap();
        assert_eq!(cfg.detectors.window_high_pct, 80);
        assert_eq!(cfg.alerts.sinks, vec!["stdout".to_string()]);
        assert_eq!(cfg.network.rpc_urls.len(), 2, "example shows 2+ RPCs");
        assert_eq!(cfg.api.bind, "127.0.0.1:8080");
    }

    #[test]
    fn routes_default_to_chat_for_warnings() {
        let raw = include_str!("../config.example.toml");
        let mut cfg: Config = toml::from_str(raw).unwrap();
        cfg.alerts.sinks = vec!["stdout".into(), "webhook".into(), "telegram".into()];
        cfg.alerts.routes = Routes::default();
        assert_eq!(cfg.alerts.sinks_for(Severity::Critical).len(), 3);
        assert_eq!(
            cfg.alerts.sinks_for(Severity::Warning),
            vec!["stdout", "telegram"]
        );
        cfg.alerts.routes.high = Some(vec!["webhook".into(), "pagerduty".into()]);
        assert_eq!(
            cfg.alerts.sinks_for(Severity::High),
            vec!["webhook"],
            "only enabled sinks"
        );
    }

    #[test]
    fn rpc_and_ws_must_pair() {
        let raw = include_str!("../config.example.toml");
        let mut cfg: Config = toml::from_str(raw).unwrap();
        cfg.network.ws_urls.pop();
        assert!(cfg.validate().is_err());
    }
}
