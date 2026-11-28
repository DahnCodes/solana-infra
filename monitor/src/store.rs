//! Postgres store (sqlx, runtime-checked queries, migrations in ./migrations).
//! The `Incident`, `Event`, `Hold` and `Alert` structs serialize to exactly the
//! shapes in docs/FRONTEND.md section 7.

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::postgres::{PgPool, PgPoolOptions, PgRow};
use sqlx::Row;

use crate::decode::{action_kind_name, ConfigAction, PendingConfig, PendingWithdrawal};
use crate::detectors::Books;
use crate::event::Severity;

#[derive(Clone)]
pub struct Store {
    pub pool: PgPool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Incident {
    pub id: String,
    pub protocol: String,
    pub detector: String,
    pub severity: String,
    pub title: String,
    pub status: String,
    pub opened_at: DateTime<Utc>,
    pub acked_by: Option<String>,
    pub acked_at: Option<DateTime<Utc>>,
    pub signatures: Vec<String>,
    #[serde(skip)]
    pub dedupe_key: String,
    #[serde(skip)]
    pub page_count: i32,
    #[serde(skip)]
    pub escalated: bool,
}

impl Incident {
    pub fn num_id(&self) -> i64 {
        self.id.parse().unwrap_or_default()
    }
    pub fn sev(&self) -> Severity {
        Severity::parse(&self.severity).unwrap_or(Severity::Critical)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Event {
    pub id: String,
    pub kind: String,
    pub signature: String,
    pub slot: i64,
    pub block_time: DateTime<Utc>,
    pub data: Value,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Hold {
    pub address: String,
    pub owner: String,
    pub mint: String,
    pub amount: String,
    pub nonce: String,
    pub created_at: DateTime<Utc>,
    pub release_at: DateTime<Utc>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Alert {
    pub id: String,
    pub sink: String,
    pub sent_at: DateTime<Utc>,
    pub ok: bool,
}

/// A guardian bot action, as `GET /actions` returns it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Action {
    pub id: String,
    pub protocol: String,
    pub kind: String,
    pub target: String,
    pub reason: String,
    pub triggered_by: Vec<String>,
    pub signature: Option<String>,
    pub ok: bool,
    pub error: Option<String>,
    pub at: DateTime<Utc>,
}

/// A mirrored PendingConfig, as `GET /pending-changes` returns it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PendingChange {
    pub protocol: String,
    pub address: String,
    pub id: String,
    pub action_kind: String,
    pub action: Value,
    pub proposed_by: String,
    pub proposed_at: DateTime<Utc>,
    pub executable_at: DateTime<Utc>,
    pub status: String,
}

#[derive(Debug, PartialEq)]
pub enum AckError {
    NotFound,
    NotOpen(String),
    Db(String),
}

const INCIDENT_SELECT: &str = "SELECT i.id, p.name AS protocol, i.detector, i.severity, i.title, \
    i.status, i.opened_at, i.acked_by, i.acked_at, i.signatures, i.dedupe_key, i.page_count, \
    i.escalated FROM incidents i JOIN protocols p ON p.id = i.protocol_id";

const EVENT_SELECT: &str = "SELECT id, kind, signature, slot, COALESCE(block_time, received_at) AS block_time, data FROM events";

const HOLD_SELECT_ID: &str =
    "SELECT id, address, owner, mint, amount::text AS amount, nonce::text AS nonce, \
    created_at, release_at, status FROM holds";

fn incident(r: PgRow) -> Incident {
    Incident {
        id: r.get::<i64, _>("id").to_string(),
        protocol: r.get("protocol"),
        detector: r.get("detector"),
        severity: r.get("severity"),
        title: r.get("title"),
        status: r.get("status"),
        opened_at: r.get("opened_at"),
        acked_by: r.get("acked_by"),
        acked_at: r.get("acked_at"),
        signatures: r.get("signatures"),
        dedupe_key: r.get("dedupe_key"),
        page_count: r.get("page_count"),
        escalated: r.get("escalated"),
    }
}

fn event(r: PgRow) -> Event {
    Event {
        id: r.get::<i64, _>("id").to_string(),
        kind: r.get("kind"),
        signature: r.get("signature"),
        slot: r.get("slot"),
        block_time: r.get("block_time"),
        data: r.get("data"),
    }
}

fn hold(r: PgRow) -> Hold {
    Hold {
        address: r.get("address"),
        owner: r.get("owner"),
        mint: r.get("mint"),
        amount: r.get("amount"),
        nonce: r.get("nonce"),
        created_at: r.get("created_at"),
        release_at: r.get("release_at"),
        status: r.get("status"),
    }
}

/// A page of results: `limit` items, plus whether there are more.
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

fn page<T>(mut rows: Vec<T>, limit: i64, cursor_of: impl Fn(&T) -> String) -> Page<T> {
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let next_cursor = if more {
        rows.last().map(cursor_of)
    } else {
        None
    };
    Page {
        items: rows,
        next_cursor,
    }
}

fn ts(secs: i64) -> DateTime<Utc> {
    DateTime::from_timestamp(secs, 0).unwrap_or_default()
}

impl Store {
    pub async fn connect(url: &str) -> anyhow::Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(url)
            .await?;
        Self::from_pool(pool).await
    }

    pub async fn from_pool(pool: PgPool) -> anyhow::Result<Self> {
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Self { pool })
    }

    pub async fn protocol(
        &self,
        name: &str,
        breakglass: &str,
        protected: &str,
    ) -> sqlx::Result<i32> {
        sqlx::query_scalar(
            "INSERT INTO protocols (name, breakglass_program, protected_program) VALUES ($1, $2, $3) \
             ON CONFLICT (name) DO UPDATE SET breakglass_program = EXCLUDED.breakglass_program, \
             protected_program = EXCLUDED.protected_program RETURNING id",
        )
        .bind(name)
        .bind(breakglass)
        .bind(protected)
        .fetch_one(&self.pool)
        .await
    }

    /// Insert once; `None` if (signature, index) was already stored.
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_event(
        &self,
        protocol_id: i32,
        kind: &str,
        signature: &str,
        index: u32,
        slot: u64,
        block_time: Option<i64>,
        data: &Value,
    ) -> sqlx::Result<Option<Event>> {
        let row = sqlx::query(
            "INSERT INTO events (protocol_id, kind, signature, event_index, slot, block_time, data) \
             VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (signature, event_index) DO NOTHING \
             RETURNING id, kind, signature, slot, COALESCE(block_time, received_at) AS block_time, data",
        )
        .bind(protocol_id)
        .bind(kind)
        .bind(signature)
        .bind(index as i32)
        .bind(slot as i64)
        .bind(block_time.map(ts))
        .bind(data)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(event))
    }

    /// The open or acked incident for this root cause, if any.
    pub async fn active_incident(
        &self,
        protocol_id: i32,
        key: &str,
    ) -> sqlx::Result<Option<Incident>> {
        let q = format!("{INCIDENT_SELECT} WHERE i.protocol_id = $1 AND i.dedupe_key = $2 AND i.status <> 'resolved' ORDER BY i.id DESC LIMIT 1");
        Ok(sqlx::query(&q)
            .bind(protocol_id)
            .bind(key)
            .fetch_optional(&self.pool)
            .await?
            .map(incident))
    }

    pub async fn create_incident(
        &self,
        protocol_id: i32,
        detector: &str,
        severity: Severity,
        title: &str,
        key: &str,
        signature: Option<&str>,
    ) -> sqlx::Result<Incident> {
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO incidents (protocol_id, detector, severity, title, dedupe_key, signatures) \
             VALUES ($1, $2, $3, $4, $5, COALESCE(ARRAY_REMOVE(ARRAY[$6::text], NULL), '{}')) RETURNING id",
        )
        .bind(protocol_id)
        .bind(detector)
        .bind(severity.as_str())
        .bind(title)
        .bind(key)
        .bind(signature)
        .fetch_one(&self.pool)
        .await?;
        Ok(self.incident(id).await?.expect("just inserted"))
    }

    /// Add evidence to an incident. `raise` sets a higher severity and title;
    /// `reopen` puts an acked incident back to open (new Critical evidence).
    pub async fn attach(
        &self,
        id: i64,
        signature: Option<&str>,
        raise: Option<(Severity, &str)>,
        reopen: bool,
    ) -> sqlx::Result<()> {
        sqlx::query(
            "UPDATE incidents SET \
               signatures = CASE WHEN $2::text IS NULL OR $2 = ANY(signatures) THEN signatures ELSE array_append(signatures, $2) END, \
               severity = COALESCE($3, severity), title = COALESCE($4, title), \
               status = CASE WHEN $5 THEN 'open' ELSE status END, \
               acked_by = CASE WHEN $5 THEN NULL ELSE acked_by END, \
               acked_at = CASE WHEN $5 THEN NULL ELSE acked_at END \
             WHERE id = $1",
        )
        .bind(id)
        .bind(signature)
        .bind(raise.map(|(s, _)| s.as_str()))
        .bind(raise.map(|(_, t)| t))
        .bind(reopen)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn mark_paged(&self, id: i64, escalated: bool) -> sqlx::Result<()> {
        sqlx::query(
            "UPDATE incidents SET last_paged_at = now(), page_count = page_count + 1, escalated = escalated OR $2 WHERE id = $1",
        )
        .bind(id)
        .bind(escalated)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn record_alert(
        &self,
        incident_id: Option<i64>,
        sink: &str,
        ok: bool,
        error: Option<&str>,
    ) -> sqlx::Result<()> {
        sqlx::query("INSERT INTO alerts (incident_id, sink, ok, error) VALUES ($1, $2, $3, $4)")
            .bind(incident_id)
            .bind(sink)
            .bind(ok)
            .bind(error)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Open (unacked) Critical incidents last paged at least `repage_secs`
    /// ago, with their age in seconds.
    pub async fn due_for_repage(
        &self,
        protocol_id: i32,
        repage_secs: u64,
    ) -> sqlx::Result<Vec<(Incident, i64)>> {
        let rows = sqlx::query(
            "SELECT i.id, p.name AS protocol, i.detector, i.severity, i.title, i.status, i.opened_at, \
               i.acked_by, i.acked_at, i.signatures, i.dedupe_key, i.page_count, i.escalated, \
               EXTRACT(EPOCH FROM now() - i.opened_at)::bigint AS age \
             FROM incidents i JOIN protocols p ON p.id = i.protocol_id \
             WHERE i.protocol_id = $1 AND i.status = 'open' AND i.severity = 'critical' \
               AND i.last_paged_at <= now() - make_interval(secs => $2) \
             ORDER BY i.id",
        )
        .bind(protocol_id)
        .bind(repage_secs as f64)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let age: i64 = r.get("age");
                (incident(r), age)
            })
            .collect())
    }

    pub async fn ack(&self, id: i64, by: &str, note: Option<&str>) -> Result<Incident, AckError> {
        let db = |e: sqlx::Error| AckError::Db(e.to_string());
        let mut tx = self.pool.begin().await.map_err(db)?;
        let status: Option<String> =
            sqlx::query_scalar("SELECT status FROM incidents WHERE id = $1 FOR UPDATE")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?;
        match status.as_deref() {
            None => return Err(AckError::NotFound),
            Some("open") => {}
            Some(other) => return Err(AckError::NotOpen(other.to_string())),
        }
        sqlx::query(
            "UPDATE incidents SET status = 'acked', acked_by = $2, acked_at = now() WHERE id = $1",
        )
        .bind(id)
        .bind(by)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        sqlx::query("INSERT INTO acks (incident_id, acked_by, note) VALUES ($1, $2, $3)")
            .bind(id)
            .bind(by)
            .bind(note)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        self.incident(id)
            .await
            .map_err(db)?
            .ok_or(AckError::NotFound)
    }

    pub async fn incident(&self, id: i64) -> sqlx::Result<Option<Incident>> {
        let q = format!("{INCIDENT_SELECT} WHERE i.id = $1");
        Ok(sqlx::query(&q)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .map(incident))
    }

    pub async fn list_incidents(
        &self,
        status: Option<&str>,
        limit: i64,
        cursor: Option<i64>,
    ) -> sqlx::Result<Page<Incident>> {
        let q = format!(
            "{INCIDENT_SELECT} WHERE ($1::text IS NULL OR i.status = $1) AND ($2::bigint IS NULL OR i.id < $2) \
             ORDER BY i.id DESC LIMIT $3"
        );
        let rows = sqlx::query(&q)
            .bind(status)
            .bind(cursor)
            .bind(limit + 1)
            .fetch_all(&self.pool)
            .await?;
        Ok(page(rows.into_iter().map(incident).collect(), limit, |i| {
            i.id.clone()
        }))
    }

    pub async fn incident_events(&self, inc: &Incident) -> sqlx::Result<Vec<Event>> {
        let q = format!("{EVENT_SELECT} WHERE signature = ANY($1) ORDER BY id");
        Ok(sqlx::query(&q)
            .bind(&inc.signatures)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(event)
            .collect())
    }

    pub async fn incident_alerts(&self, id: i64) -> sqlx::Result<Vec<Alert>> {
        let rows = sqlx::query(
            "SELECT id, sink, sent_at, ok FROM alerts WHERE incident_id = $1 ORDER BY id",
        )
        .bind(id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| Alert {
                id: r.get::<i64, _>("id").to_string(),
                sink: r.get("sink"),
                sent_at: r.get("sent_at"),
                ok: r.get("ok"),
            })
            .collect())
    }

    pub async fn upsert_hold(
        &self,
        protocol_id: i32,
        address: &str,
        h: &PendingWithdrawal,
    ) -> sqlx::Result<()> {
        sqlx::query(
            "INSERT INTO holds (protocol_id, address, owner, mint, amount, nonce, created_at, release_at, status) \
             VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7, $8, $9) \
             ON CONFLICT (address) DO UPDATE SET status = EXCLUDED.status, amount = EXCLUDED.amount, \
             release_at = EXCLUDED.release_at, updated_at = now()",
        )
        .bind(protocol_id)
        .bind(address)
        .bind(h.owner.to_string())
        .bind(h.mint.to_string())
        .bind(h.amount.to_string())
        .bind(h.nonce.to_string())
        .bind(ts(h.created_at))
        .bind(ts(h.release_at))
        .bind(h.status_str())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_holds(
        &self,
        owner: Option<&str>,
        status: Option<&str>,
        limit: i64,
        cursor: Option<i64>,
    ) -> sqlx::Result<Page<Hold>> {
        let q = format!(
            "{HOLD_SELECT_ID} WHERE ($1::text IS NULL OR owner = $1) AND ($2::text IS NULL OR status = $2) \
             AND ($3::bigint IS NULL OR id < $3) ORDER BY id DESC LIMIT $4"
        );
        let rows = sqlx::query(&q)
            .bind(owner)
            .bind(status)
            .bind(cursor)
            .bind(limit + 1)
            .fetch_all(&self.pool)
            .await?;
        let items: Vec<(i64, Hold)> = rows
            .into_iter()
            .map(|r| (r.get::<i64, _>("id"), hold(r)))
            .collect();
        let p = page(items, limit, |(id, _)| id.to_string());
        Ok(Page {
            items: p.items.into_iter().map(|(_, h)| h).collect(),
            next_cursor: p.next_cursor,
        })
    }

    pub async fn list_events(
        &self,
        kind: Option<&str>,
        since: Option<DateTime<Utc>>,
        limit: i64,
        cursor: Option<i64>,
    ) -> sqlx::Result<Page<Event>> {
        let q = format!(
            "{EVENT_SELECT} WHERE ($1::text IS NULL OR kind = $1) AND ($2::timestamptz IS NULL OR COALESCE(block_time, received_at) >= $2) \
             AND ($3::bigint IS NULL OR id < $3) ORDER BY id DESC LIMIT $4"
        );
        let rows = sqlx::query(&q)
            .bind(kind)
            .bind(since)
            .bind(cursor)
            .bind(limit + 1)
            .fetch_all(&self.pool)
            .await?;
        Ok(page(rows.into_iter().map(event).collect(), limit, |e| {
            e.id.clone()
        }))
    }

    // ---- Phase 6: flows, bot actions, pending changes --------------------

    pub async fn history_start(&self, protocol_id: i32) -> sqlx::Result<i64> {
        sqlx::query_scalar(
            "SELECT EXTRACT(EPOCH FROM created_at)::bigint FROM protocols WHERE id = $1",
        )
        .bind(protocol_id)
        .fetch_one(&self.pool)
        .await
    }

    pub async fn insert_flow(
        &self,
        protocol_id: i32,
        kind: &str,
        owner: &str,
        mint: &str,
        amount: u64,
        signature: Option<&str>,
    ) -> sqlx::Result<()> {
        sqlx::query("INSERT INTO flows (protocol_id, kind, owner, mint, amount, signature) VALUES ($1, $2, $3, $4, $5::numeric, $6)")
            .bind(protocol_id)
            .bind(kind)
            .bind(owner)
            .bind(mint)
            .bind(amount.to_string())
            .bind(signature)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Hourly requested outflow (allowed + held) per mint over the last 31 days.
    pub async fn velocity_seed(&self, protocol_id: i32) -> sqlx::Result<Vec<(String, i64, u128)>> {
        let rows = sqlx::query(
            "SELECT mint, EXTRACT(EPOCH FROM date_trunc('hour', at))::bigint AS hour, SUM(amount)::text AS total \
             FROM flows WHERE protocol_id = $1 AND kind IN ('outflow', 'held') AND at > now() - interval '31 days' \
             GROUP BY 1, 2",
        )
        .bind(protocol_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                (
                    r.get("mint"),
                    r.get("hour"),
                    r.get::<String, _>("total").parse().unwrap_or(0),
                )
            })
            .collect())
    }

    /// Per (owner, mint): deposited and withdrawn from flows, held from pending holds;
    /// plus the pending holds themselves.
    #[allow(clippy::type_complexity)]
    pub async fn deposit_seed(
        &self,
        protocol_id: i32,
    ) -> sqlx::Result<(
        Vec<(String, String, Books)>,
        Vec<(String, String, String, u128)>,
    )> {
        let n = |r: &PgRow, c: &str| r.get::<String, _>(c).parse::<u128>().unwrap_or(0);
        let rows = sqlx::query(
            "SELECT owner, mint, \
               COALESCE(SUM(amount) FILTER (WHERE kind = 'deposit'), 0)::text AS deposited, \
               COALESCE(SUM(amount) FILTER (WHERE kind IN ('outflow', 'claim')), 0)::text AS withdrawn \
             FROM flows WHERE protocol_id = $1 GROUP BY 1, 2",
        )
        .bind(protocol_id)
        .fetch_all(&self.pool)
        .await?;
        let mut books: std::collections::HashMap<(String, String), Books> = rows
            .iter()
            .map(|r| {
                (
                    (r.get("owner"), r.get("mint")),
                    Books {
                        deposited: n(r, "deposited"),
                        withdrawn: n(r, "withdrawn"),
                        held: 0,
                    },
                )
            })
            .collect();
        let holds = sqlx::query(
            "SELECT address, owner, mint, amount::text AS amount FROM holds \
             WHERE protocol_id = $1 AND status IN ('queued', 'frozen', 'released')",
        )
        .bind(protocol_id)
        .fetch_all(&self.pool)
        .await?;
        let mut pending = vec![];
        for r in &holds {
            let (owner, mint, amount): (String, String, u128) =
                (r.get("owner"), r.get("mint"), n(r, "amount"));
            books.entry((owner.clone(), mint.clone())).or_default().held += amount;
            pending.push((r.get("address"), owner, mint, amount));
        }
        Ok((
            books.into_iter().map(|((o, m), b)| (o, m, b)).collect(),
            pending,
        ))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn insert_action(
        &self,
        protocol_id: i32,
        kind: &str,
        target: &str,
        reason: &str,
        triggered_by: &[String],
        signature: Option<&str>,
        ok: bool,
        error: Option<&str>,
    ) -> sqlx::Result<Action> {
        let r = sqlx::query(
            "INSERT INTO actions (protocol_id, kind, target, reason, triggered_by, signature, ok, error) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, (SELECT name FROM protocols WHERE id = $1) AS protocol, kind, target, reason, triggered_by, signature, ok, error, at",
        )
        .bind(protocol_id)
        .bind(kind)
        .bind(target)
        .bind(reason)
        .bind(triggered_by)
        .bind(signature)
        .bind(ok)
        .bind(error)
        .fetch_one(&self.pool)
        .await?;
        Ok(action(r))
    }

    pub async fn list_actions(
        &self,
        kind: Option<&str>,
        limit: i64,
        cursor: Option<i64>,
    ) -> sqlx::Result<Page<Action>> {
        let rows = sqlx::query(
            "SELECT a.id, p.name AS protocol, a.kind, a.target, a.reason, a.triggered_by, a.signature, a.ok, a.error, a.at \
             FROM actions a JOIN protocols p ON p.id = a.protocol_id \
             WHERE ($1::text IS NULL OR a.kind = $1) AND ($2::bigint IS NULL OR a.id < $2) ORDER BY a.id DESC LIMIT $3",
        )
        .bind(kind)
        .bind(cursor)
        .bind(limit + 1)
        .fetch_all(&self.pool)
        .await?;
        Ok(page(rows.into_iter().map(action).collect(), limit, |a| {
            a.id.clone()
        }))
    }

    pub async fn upsert_pending(
        &self,
        protocol_id: i32,
        address: &str,
        p: &PendingConfig,
    ) -> sqlx::Result<()> {
        let kind = match p.action {
            ConfigAction::RaiseLimits { .. } => 0,
            ConfigAction::AddGuardian { .. } => 1,
            ConfigAction::SetAdmin { .. } => 2,
            ConfigAction::ReleaseHeld { .. } => 3,
            ConfigAction::ChangePolicy { .. } => 4,
        };
        sqlx::query(
            "INSERT INTO pending_changes (protocol_id, address, change_id, action_kind, action, proposed_by, proposed_at, executable_at, status) \
             VALUES ($1, $2, $3::numeric, $4, $5, $6, $7, $8, $9) \
             ON CONFLICT (address) DO UPDATE SET status = EXCLUDED.status, updated_at = now()",
        )
        .bind(protocol_id)
        .bind(address)
        .bind(p.id.to_string())
        .bind(action_kind_name(kind))
        .bind(serde_json::to_value(&p.action).unwrap_or_default())
        .bind(p.proposed_by.to_string())
        .bind(ts(p.proposed_at))
        .bind(ts(p.executable_at))
        .bind(p.status_str())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_pending(
        &self,
        status: Option<&str>,
        limit: i64,
        cursor: Option<i64>,
    ) -> sqlx::Result<Page<PendingChange>> {
        let rows = sqlx::query(
            "SELECT c.id, p.name AS protocol, c.address, c.change_id::text AS change_id, c.action_kind, c.action, \
               c.proposed_by, c.proposed_at, c.executable_at, c.status \
             FROM pending_changes c JOIN protocols p ON p.id = c.protocol_id \
             WHERE ($1::text IS NULL OR c.status = $1) AND ($2::bigint IS NULL OR c.id < $2) \
             ORDER BY c.id DESC LIMIT $3",
        )
        .bind(status)
        .bind(cursor)
        .bind(limit + 1)
        .fetch_all(&self.pool)
        .await?;
        let items: Vec<(i64, PendingChange)> = rows
            .into_iter()
            .map(|r| {
                (
                    r.get::<i64, _>("id"),
                    PendingChange {
                        protocol: r.get("protocol"),
                        address: r.get("address"),
                        id: r.get("change_id"),
                        action_kind: r.get("action_kind"),
                        action: r.get("action"),
                        proposed_by: r.get("proposed_by"),
                        proposed_at: r.get("proposed_at"),
                        executable_at: r.get("executable_at"),
                        status: r.get("status"),
                    },
                )
            })
            .collect();
        let p = page(items, limit, |(id, _)| id.to_string());
        Ok(Page {
            items: p.items.into_iter().map(|(_, c)| c).collect(),
            next_cursor: p.next_cursor,
        })
    }
}

fn action(r: PgRow) -> Action {
    Action {
        id: r.get::<i64, _>("id").to_string(),
        protocol: r.get("protocol"),
        kind: r.get("kind"),
        target: r.get("target"),
        reason: r.get("reason"),
        triggered_by: r.get("triggered_by"),
        signature: r.get("signature"),
        ok: r.get("ok"),
        error: r.get("error"),
        at: r.get("at"),
    }
}
