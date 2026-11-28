//! Decoding Breakglass events and accounts.
//!
//! The monitor is a separate Cargo workspace (Solana client crates and Anchor
//! program crates fight over versions), so it doesn't depend on the program
//! crate. These structs mirror `programs/breakglass/src/events.rs` and the
//! account layouts by hand. `tests::matches_committed_idl` decodes sample
//! bytes built from `clients/ts/idl/breakglass.json`, field by field, so any
//! drift between the program and this file fails `cargo test`.
//!
//! Events are emitted with `emit_cpi!`: the data of a self-CPI inner
//! instruction is `EVENT_IX_TAG (8, LE) | sha256("event:<Name>")[..8] | borsh`.

use std::fmt;
use std::sync::OnceLock;

use borsh::BorshDeserialize;
use serde::{Serialize, Serializer};
use sha2::{Digest, Sha256};

/// Anchor's `EVENT_IX_TAG` (0x1d9acb512ea545e4) as it appears in instruction data.
pub const EVENT_IX_TAG_LE: [u8; 8] = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];

/// A pubkey; serializes as base58.
#[derive(BorshDeserialize, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Pk(pub [u8; 32]);

impl fmt::Display for Pk {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&bs58::encode(self.0).into_string())
    }
}
impl fmt::Debug for Pk {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}
impl Serialize for Pk {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// A u64 amount; serializes as a decimal string (u64 doesn't fit a JS number).
#[derive(BorshDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct U64(pub u64);
impl Serialize for U64 {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0.to_string())
    }
}

/// An i64 (unix time); serializes as a decimal string, like U64.
#[derive(BorshDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct I64(pub i64);
impl Serialize for I64 {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0.to_string())
    }
}

macro_rules! events {
    ($( $name:ident { $( $field:ident : $ty:ty ),* $(,)? } )*) => {
        $(
            #[derive(BorshDeserialize, Serialize, Debug, Clone, PartialEq)]
            #[serde(rename_all = "camelCase")]
            pub struct $name { $( pub $field: $ty ),* }
        )*

        /// Every Breakglass event. Names match the Rust structs (and the
        /// `kind` the monitor API reports).
        #[derive(Debug, Clone, PartialEq)]
        pub enum BgEvent { $( $name($name) ),* }

        impl BgEvent {
            pub fn name(&self) -> &'static str {
                match self { $( BgEvent::$name(_) => stringify!($name) ),* }
            }

            /// Fields as JSON, camelCase; u64/i64 as decimal strings, pubkeys base58.
            pub fn data_json(&self) -> serde_json::Value {
                match self { $( BgEvent::$name(e) => serde_json::to_value(e).unwrap_or_default() ),* }
            }

            /// Every event name this monitor can decode.
            pub fn names() -> &'static [&'static str] {
                &[ $( stringify!($name) ),* ]
            }

            fn decode_named(name: &str, data: &[u8]) -> Option<std::io::Result<BgEvent>> {
                match name {
                    $( stringify!($name) => Some($name::try_from_slice(data).map(BgEvent::$name)), )*
                    _ => None,
                }
            }
        }
    };
}

events! {
    ConfigInitialized { config: Pk, protected_program: Pk, admin: Pk, guardians: Vec<Pk> }
    Paused { config: Pk, scopes_mask: U64, paused_until: I64, by: Pk, kind: u8, reason: u16 }
    PauseRenewed { config: Pk, scopes_mask: U64, paused_until: I64, by: Pk, renewals: u8 }
    Unpaused { config: Pk, scopes_mask: U64, by: Pk }
    GuardianRemoved { config: Pk, guardian: Pk }
    OutflowRecorded { config: Pk, mint: Pk, owner: Pk, amount: U64, window_total: U64, window_cap: U64 }
    LargeWithdrawalQueued { config: Pk, hold: Pk, mint: Pk, owner: Pk, amount: U64, release_at: I64 }
    WithdrawalScreenQueued { config: Pk, hold: Pk, mint: Pk, owner: Pk, amount: U64, release_at: I64 }
    LimitHoldQueued { config: Pk, hold: Pk, mint: Pk, owner: Pk, amount: U64, release_at: I64 }
    LimitTripped { config: Pk, mint: Pk, scope: u8, window_total: U64, window_cap: U64, paused_until: I64 }
    HoldFrozen { config: Pk, hold: Pk, by: Pk }
    HoldResolved { config: Pk, hold: Pk, outcome: u8 }
    ConfigChangeProposed { config: Pk, change: Pk, action_kind: u8, executable_at: I64 }
    ConfigChangeExecuted { config: Pk, change: Pk }
    ConfigChangeCancelled { config: Pk, change: Pk }
    LimitsTightened { config: Pk, flow_limiter: Pk, mint: Pk }
    ConfigChangeVetoed { config: Pk, change: Pk, by: Pk }
}

fn anchor_disc(prefix: &str, name: &str) -> [u8; 8] {
    let h = Sha256::digest(format!("{prefix}:{name}").as_bytes());
    h[..8].try_into().expect("8 bytes")
}

fn event_discs() -> &'static [([u8; 8], &'static str)] {
    static T: OnceLock<Vec<([u8; 8], &'static str)>> = OnceLock::new();
    T.get_or_init(|| {
        BgEvent::names()
            .iter()
            .map(|n| (anchor_disc("event", n), *n))
            .collect()
    })
}

#[derive(Debug, PartialEq)]
pub enum DecodeError {
    /// Has the event tag and a discriminator we don't know: the program has
    /// an event this monitor doesn't (redeploy the monitor).
    UnknownEvent([u8; 8]),
    /// Known event, but the bytes don't fit its layout.
    Malformed(&'static str, String),
}

/// Decode one inner-instruction's data. `None` if it isn't an event at all.
pub fn decode_event(ix_data: &[u8]) -> Option<Result<BgEvent, DecodeError>> {
    if ix_data.len() < 16 || ix_data[..8] != EVENT_IX_TAG_LE {
        return None;
    }
    let disc: [u8; 8] = ix_data[8..16].try_into().ok()?;
    let Some((_, name)) = event_discs().iter().find(|(d, _)| *d == disc) else {
        return Some(Err(DecodeError::UnknownEvent(disc)));
    };
    Some(
        BgEvent::decode_named(name, &ix_data[16..])
            .expect("name from the table")
            .map_err(|e| DecodeError::Malformed(name, e.to_string())),
    )
}

/// SPL Token / Token-2022 account: (mint, amount). Base layout is shared.
pub fn token_account(data: &[u8]) -> Option<(Pk, u64)> {
    if data.len() < 72 {
        return None;
    }
    let mint = Pk(data[0..32].try_into().ok()?);
    let amount = u64::from_le_bytes(data[64..72].try_into().ok()?);
    Some((mint, amount))
}

/// Breakglass `PendingWithdrawal`, mirrored into the monitor's `holds` table.
#[derive(BorshDeserialize, Debug, Clone, PartialEq)]
pub struct PendingWithdrawal {
    pub bump: u8,
    pub config: Pk,
    pub owner: Pk,
    pub mint: Pk,
    pub amount: u64,
    pub nonce: u64,
    pub created_at: i64,
    pub release_at: i64,
    pub status: u8,
    pub scope: u8,
    pub kind: u8,
}

impl PendingWithdrawal {
    pub fn decode(data: &[u8]) -> Option<Self> {
        if data.len() < 8 || data[..8] != anchor_disc("account", "PendingWithdrawal") {
            return None;
        }
        Self::deserialize(&mut &data[8..]).ok()
    }

    pub fn status_str(&self) -> &'static str {
        match self.status {
            0 => "queued",
            1 => "frozen",
            2 => "released",
            3 => "rejected",
            4 => "claimed",
            _ => "unknown",
        }
    }
}

/// Hex sha256 of an account's data (ProgramData change detection).
pub fn data_hash(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// Breakglass `LimiterParams` (inside `ConfigAction::RaiseLimits`).
#[derive(BorshDeserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LimiterParams {
    pub window_secs: I64,
    pub cap_absolute: U64,
    pub cap_bps_of_vault: u16,
    pub large_threshold: U64,
    pub large_threshold_bps: u16,
    pub hold_secs: I64,
    pub auto_trip_secs: I64,
    pub instant_allowance: U64,
    pub screen_secs: I64,
}

/// Breakglass `PausePolicy` (inside `ConfigAction::ChangePolicy`).
#[derive(BorshDeserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PausePolicy {
    pub max_guardian_pause_secs: I64,
    pub max_renewals: u8,
    pub cooldown_secs: I64,
    pub budget_secs_per_period: I64,
    pub budget_period_secs: I64,
    pub auto_trip_secs: I64,
}

/// Breakglass `ConfigAction`. Serializes like Anchor's TS coder:
/// `{ "raiseLimits": { "mint": ..., "params": { ... } } }`.
#[derive(BorshDeserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ConfigAction {
    RaiseLimits {
        mint: Pk,
        params: LimiterParams,
    },
    AddGuardian {
        guardian: Pk,
    },
    SetAdmin {
        admin: Pk,
    },
    ReleaseHeld {
        hold: Pk,
    },
    ChangePolicy {
        policy: PausePolicy,
        unpausable_mask: U64,
        timelock_secs: I64,
    },
}

/// Breakglass `PendingConfig`, mirrored into the monitor's `pending_changes` table.
#[derive(BorshDeserialize, Debug, Clone, PartialEq)]
pub struct PendingConfig {
    pub bump: u8,
    pub config: Pk,
    pub id: u64,
    pub action: ConfigAction,
    pub proposed_by: Pk,
    pub proposed_at: i64,
    pub executable_at: i64,
    pub vetoed: bool,
    pub executed: bool,
    pub cancelled: bool,
}

impl PendingConfig {
    pub fn decode(data: &[u8]) -> Option<Self> {
        if data.len() < 8 || data[..8] != anchor_disc("account", "PendingConfig") {
            return None;
        }
        Self::deserialize(&mut &data[8..]).ok()
    }

    /// pending | vetoed | executed | cancelled
    pub fn status_str(&self) -> &'static str {
        if self.cancelled {
            "cancelled"
        } else if self.executed {
            "executed"
        } else if self.vetoed {
            "vetoed"
        } else {
            "pending"
        }
    }
}

/// `ConfigChangeProposed.action_kind` names.
pub fn action_kind_name(kind: u8) -> &'static str {
    match kind {
        0 => "RaiseLimits",
        1 => "AddGuardian",
        2 => "SetAdmin",
        3 => "ReleaseHeld",
        4 => "ChangePolicy",
        _ => "Unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// The committed IDL, the same one the frontend uses.
    fn idl() -> Value {
        serde_json::from_str(include_str!("../../clients/ts/idl/breakglass.json")).unwrap()
    }

    fn camel(s: &str) -> String {
        let mut out = String::new();
        let mut up = false;
        for c in s.chars() {
            if c == '_' {
                up = true;
            } else if up {
                out.extend(c.to_uppercase());
                up = false;
            } else {
                out.push(c);
            }
        }
        out
    }

    /// Borsh bytes and the expected JSON for one IDL field, with sample value `i`.
    fn sample(ty: &Value, i: u8) -> (Vec<u8>, Value) {
        match ty {
            Value::String(t) => match t.as_str() {
                "pubkey" => (vec![i; 32], Value::String(Pk([i; 32]).to_string())),
                "u8" => (vec![i], Value::from(i)),
                "u16" => {
                    let v = 1_000 + i as u16;
                    (v.to_le_bytes().to_vec(), Value::from(v))
                }
                "u64" => {
                    let v = u64::MAX - i as u64;
                    (v.to_le_bytes().to_vec(), Value::String(v.to_string()))
                }
                "i64" => {
                    let v = -(1_000_000 + i as i64);
                    (v.to_le_bytes().to_vec(), Value::String(v.to_string()))
                }
                "bool" => (vec![i % 2], Value::Bool(i % 2 == 1)),
                other => panic!("IDL type {other} has no sample; extend this test and decode.rs"),
            },
            Value::Object(o) if o.contains_key("vec") => {
                let (inner, expected) = sample(&o["vec"], i);
                let mut b = 2u32.to_le_bytes().to_vec();
                b.extend(&inner);
                b.extend(&inner);
                (b, Value::Array(vec![expected.clone(), expected]))
            }
            Value::Object(o) if o.contains_key("defined") => {
                let name = o["defined"]["name"].as_str().unwrap();
                let idl = idl();
                let ty = idl["types"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|t| t["name"] == name)
                    .unwrap()
                    .clone();
                assert_eq!(
                    ty["type"]["kind"], "struct",
                    "{name}: enums are sampled per variant"
                );
                fields_sample(&ty["type"]["fields"], i)
            }
            other => panic!("IDL type {other} not handled"),
        }
    }

    /// Borsh bytes and expected camelCase JSON object for a list of named IDL fields.
    fn fields_sample(fields: &Value, base: u8) -> (Vec<u8>, Value) {
        let mut bytes = vec![];
        let mut json = serde_json::Map::new();
        for (k, f) in fields.as_array().unwrap().iter().enumerate() {
            let (b, v) = sample(&f["type"], base.wrapping_add(k as u8 + 1));
            bytes.extend(b);
            json.insert(camel(f["name"].as_str().unwrap()), v);
        }
        (bytes, Value::Object(json))
    }

    fn lower_first(s: &str) -> String {
        let mut c = s.chars();
        c.next()
            .map(|f| f.to_lowercase().collect::<String>() + c.as_str())
            .unwrap_or_default()
    }

    /// Every ConfigAction variant from the IDL decodes into the same JSON
    /// Anchor's TS coder would produce, and PendingConfig's layout matches.
    #[test]
    fn config_action_and_pending_config_match_idl() {
        let idl = idl();
        let types = idl["types"].as_array().unwrap();
        let ca = types.iter().find(|t| t["name"] == "ConfigAction").unwrap();
        let variants = ca["type"]["variants"].as_array().unwrap();
        assert_eq!(variants.len(), 5);
        for (tag, v) in variants.iter().enumerate() {
            let (body, fields) = fields_sample(&v["fields"], 10 * tag as u8);
            let mut data = vec![tag as u8];
            data.extend(body);
            let decoded = ConfigAction::try_from_slice(&data)
                .unwrap_or_else(|e| panic!("{}: {e}", v["name"]));
            let expected = serde_json::json!({ lower_first(v["name"].as_str().unwrap()): fields });
            assert_eq!(
                serde_json::to_value(&decoded).unwrap(),
                expected,
                "{}",
                v["name"]
            );
            assert_eq!(action_kind_name(tag as u8), v["name"].as_str().unwrap());
        }

        let pc = types.iter().find(|t| t["name"] == "PendingConfig").unwrap();
        let names: Vec<&str> = pc["type"]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "bump",
                "config",
                "id",
                "action",
                "proposed_by",
                "proposed_at",
                "executable_at",
                "vetoed",
                "executed",
                "cancelled"
            ]
        );
        let mut data = anchor_disc("account", "PendingConfig").to_vec();
        data.push(1);
        data.extend([4u8; 32]);
        data.extend(7u64.to_le_bytes());
        data.push(1); // AddGuardian
        data.extend([5u8; 32]);
        data.extend([6u8; 32]);
        data.extend(100i64.to_le_bytes());
        data.extend(200i64.to_le_bytes());
        data.extend([1, 0, 0]);
        let p = PendingConfig::decode(&data).unwrap();
        assert_eq!((p.id, p.executable_at, p.status_str()), (7, 200, "vetoed"));
        assert_eq!(
            p.action,
            ConfigAction::AddGuardian {
                guardian: Pk([5; 32])
            }
        );
    }

    #[test]
    fn matches_committed_idl() {
        let idl = idl();
        let events = idl["events"].as_array().unwrap();
        let idl_names: Vec<&str> = events.iter().map(|e| e["name"].as_str().unwrap()).collect();
        let mut ours = BgEvent::names().to_vec();
        let mut theirs = idl_names.clone();
        ours.sort();
        theirs.sort();
        assert_eq!(ours, theirs, "event set differs from the IDL");

        for ev in events {
            let name = ev["name"].as_str().unwrap();
            let disc: Vec<u8> = ev["discriminator"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b.as_u64().unwrap() as u8)
                .collect();
            assert_eq!(disc, anchor_disc("event", name), "{name} discriminator");

            let ty = idl["types"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["name"] == name)
                .unwrap_or_else(|| panic!("{name} type missing in IDL"));
            let mut data = EVENT_IX_TAG_LE.to_vec();
            data.extend(disc);
            let mut expected = serde_json::Map::new();
            for (i, f) in ty["type"]["fields"].as_array().unwrap().iter().enumerate() {
                let (bytes, json) = sample(&f["type"], i as u8 + 1);
                data.extend(bytes);
                expected.insert(camel(f["name"].as_str().unwrap()), json);
            }
            let decoded = decode_event(&data)
                .expect("recognized as an event")
                .unwrap_or_else(|e| panic!("{name}: {e:?}"));
            assert_eq!(decoded.name(), name);
            assert_eq!(
                decoded.data_json(),
                Value::Object(expected),
                "{name} fields"
            );
        }
    }

    #[test]
    fn non_events_and_unknown_events() {
        assert_eq!(decode_event(&[1, 2, 3]), None);
        assert_eq!(decode_event(&[0u8; 40]), None);
        let mut data = EVENT_IX_TAG_LE.to_vec();
        data.extend([9u8; 8]);
        assert_eq!(
            decode_event(&data),
            Some(Err(DecodeError::UnknownEvent([9; 8])))
        );
        // A known event with truncated data is malformed, not silently dropped.
        let mut data = EVENT_IX_TAG_LE.to_vec();
        data.extend(anchor_disc("event", "Unpaused"));
        data.extend([0u8; 10]);
        assert!(matches!(
            decode_event(&data),
            Some(Err(DecodeError::Malformed("Unpaused", _)))
        ));
    }

    #[test]
    fn pending_withdrawal_matches_idl_layout() {
        let idl = idl();
        let ty = idl["types"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "PendingWithdrawal")
            .unwrap();
        let fields: Vec<&str> = ty["type"]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            fields,
            [
                "bump",
                "config",
                "owner",
                "mint",
                "amount",
                "nonce",
                "created_at",
                "release_at",
                "status",
                "scope",
                "kind"
            ]
        );
        let mut data = anchor_disc("account", "PendingWithdrawal").to_vec();
        data.push(7);
        data.extend([1u8; 32]);
        data.extend([2u8; 32]);
        data.extend([3u8; 32]);
        data.extend(500u64.to_le_bytes());
        data.extend(42u64.to_le_bytes());
        data.extend(100i64.to_le_bytes());
        data.extend(200i64.to_le_bytes());
        data.extend([1, 1, 0]);
        let h = PendingWithdrawal::decode(&data).unwrap();
        assert_eq!((h.amount, h.nonce, h.release_at), (500, 42, 200));
        assert_eq!(h.status_str(), "frozen");
        assert_eq!(h.owner, Pk([2; 32]));
        assert!(PendingWithdrawal::decode(&data[1..]).is_none());
    }

    #[test]
    fn token_account_fields() {
        let mut data = vec![5u8; 32];
        data.extend([0u8; 32]);
        data.extend(1_234u64.to_le_bytes());
        data.extend([0u8; 93]);
        assert_eq!(token_account(&data), Some((Pk([5; 32]), 1_234)));
        assert_eq!(token_account(&data[..50]), None);
    }
}
