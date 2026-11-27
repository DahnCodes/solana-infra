//! Alert sinks. Phase 5 adds Telegram and signed-webhook sinks; PagerDuty later.

use crate::event::Signal;

pub trait AlertSink: Send {
    fn name(&self) -> &'static str;
    fn send(&mut self, signal: &Signal) -> anyhow::Result<()>;
}

pub struct StdoutSink;

impl AlertSink for StdoutSink {
    fn name(&self) -> &'static str {
        "stdout"
    }

    fn send(&mut self, s: &Signal) -> anyhow::Result<()> {
        println!(
            "[{:?}] {} | {} | {}{}",
            s.severity,
            s.detector,
            s.title,
            s.detail,
            s.signature.as_ref().map(|sig| format!(" | tx {sig}")).unwrap_or_default()
        );
        Ok(())
    }
}

pub fn build(names: &[String]) -> anyhow::Result<Vec<Box<dyn AlertSink>>> {
    names
        .iter()
        .map(|n| match n.as_str() {
            "stdout" => Ok(Box::new(StdoutSink) as Box<dyn AlertSink>),
            other => anyhow::bail!("sink '{other}' is not implemented yet (see BUILD_PLAN.md Phase 5)"),
        })
        .collect()
}
