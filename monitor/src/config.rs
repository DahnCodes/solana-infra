use anyhow::Context;
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub network: Network,
    pub protocol: Protocol,
    pub detectors: DetectorConfig,
    pub alerts: AlertConfig,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Network {
    pub rpc_urls: Vec<String>,
    pub ws_urls: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Protocol {
    pub name: String,
    pub breakglass_program: String,
    pub protected_program: String,
    #[serde(default)]
    pub vault_token_accounts: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DetectorConfig {
    pub window_warning_pct: u8,
    pub window_high_pct: u8,
    pub heartbeat_timeout_secs: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AlertConfig {
    pub sinks: Vec<String>,
    pub critical_repage_secs: u64,
}

impl Config {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("reading config {}", path.display()))?;
        let cfg: Config = toml::from_str(&raw).context("parsing config")?;
        anyhow::ensure!(!cfg.network.rpc_urls.is_empty(), "need at least one rpc_url");
        Ok(cfg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn example_config_parses() {
        let raw = include_str!("../config.example.toml");
        let cfg: Config = toml::from_str(raw).unwrap();
        assert_eq!(cfg.detectors.window_high_pct, 80);
        assert_eq!(cfg.alerts.sinks, vec!["stdout".to_string()]);
    }
}
