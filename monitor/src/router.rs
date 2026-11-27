//! Routes signals to sinks. Phase 5 adds incidents in Postgres, dedupe windows,
//! severity routing per contact, and escalation of unacknowledged Critical alerts.

use crate::{event::Signal, sinks::AlertSink};

pub struct Router {
    sinks: Vec<Box<dyn AlertSink>>,
}

impl Router {
    pub fn new(sinks: Vec<Box<dyn AlertSink>>) -> Self {
        Self { sinks }
    }

    pub fn dispatch(&mut self, signal: &Signal) {
        for sink in self.sinks.iter_mut() {
            if let Err(e) = sink.send(signal) {
                // A failing sink must never stop the others.
                tracing::error!(sink = sink.name(), error = %e, "alert sink failed");
            }
        }
    }
}
