//! Tests that need Postgres: the store, the router (incidents, routing,
//! re-paging) and one test per API endpoint checking the exact JSON shape in
//! docs/FRONTEND.md section 7.
//!
//! `sqlx::test` creates a fresh database per test from DATABASE_URL
//! (default below: the docker-compose Postgres) and applies ./migrations.
//! Start it first: `docker compose -f monitor/docker-compose.yml up -d`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::sync::broadcast;
use tower::ServiceExt;

use crate::api::{router as api_router, ApiState};
use crate::config::{AlertConfig, Routes};
use crate::decode::{PendingWithdrawal, Pk};
use crate::event::{Severity, Signal};
use crate::health::Health;
use crate::router::Router;
use crate::sinks::{Alert, AlertSink, Sinks};
use crate::store::Store;

// ---- helpers -----------------------------------------------------------------

struct Capture(Arc<Mutex<Vec<Alert>>>);

#[async_trait]
impl AlertSink for Capture {
    fn name(&self) -> &'static str {
        "stdout"
    }
    async fn send(&self, a: &Alert) -> anyhow::Result<()> {
        self.0.lock().unwrap().push(a.clone());
        Ok(())
    }
}

fn alert_cfg() -> AlertConfig {
    AlertConfig {
        sinks: vec!["stdout".into()],
        critical_repage_secs: 120,
        escalate_after_secs: 300,
        explorer_tx_url: "https://x/tx/{signature}".into(),
        routes: Routes::default(),
    }
}

async fn setup(pool: PgPool) -> (Store, i32, Router, Arc<Mutex<Vec<Alert>>>) {
    let store = Store::from_pool(pool).await.unwrap();
    let pid = store.protocol("test-vault", "BG", "TV").await.unwrap();
    let seen = Arc::new(Mutex::new(vec![]));
    let mut sinks: Sinks = Default::default();
    sinks.insert("stdout".into(), Arc::new(Capture(seen.clone())));
    let (tx, _) = broadcast::channel(16);
    let router = Router::new(
        store.clone(),
        pid,
        "test-vault".into(),
        alert_cfg(),
        sinks,
        tx,
    );
    (store, pid, router, seen)
}

/// Alerts are sent in background tasks; wait for `n` of them.
async fn wait_alerts(seen: &Arc<Mutex<Vec<Alert>>>, n: usize) -> Vec<Alert> {
    for _ in 0..100 {
        if seen.lock().unwrap().len() >= n {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(Duration::from_millis(50)).await; // and no more than n
    seen.lock().unwrap().clone()
}

fn signal(sev: Severity, key: &str, sig: Option<&str>) -> Signal {
    Signal {
        detector: "pause_trip",
        severity: sev,
        title: format!("{sev:?} thing"),
        detail: "d".into(),
        actions: "a".into(),
        signature: sig.map(String::from),
        dedupe_key: key.into(),
    }
}

fn keys(v: &Value) -> Vec<String> {
    let mut k: Vec<String> = v.as_object().expect("object").keys().cloned().collect();
    k.sort();
    k
}

fn sorted(k: &[&str]) -> Vec<String> {
    let mut v: Vec<String> = k.iter().map(|s| s.to_string()).collect();
    v.sort();
    v
}

const INCIDENT_KEYS: &[&str] = &[
    "id",
    "protocol",
    "detector",
    "severity",
    "title",
    "status",
    "opened_at",
    "acked_by",
    "acked_at",
    "signatures",
];

fn assert_incident_shape(v: &Value) {
    assert_eq!(keys(v), sorted(INCIDENT_KEYS));
    assert!(v["id"].is_string());
    assert!(["info", "warning", "high", "critical"].contains(&v["severity"].as_str().unwrap()));
    assert!(["open", "acked", "resolved"].contains(&v["status"].as_str().unwrap()));
    assert!(chrono::DateTime::parse_from_rfc3339(v["opened_at"].as_str().unwrap()).is_ok());
    assert!(v["signatures"]
        .as_array()
        .unwrap()
        .iter()
        .all(Value::is_string));
}

async fn api(store: &Store, token: Option<&str>) -> axum::Router {
    let health = Health::new(
        vec![
            ("rpc0".into(), "http://a".into()),
            ("rpc1".into(), "http://b".into()),
        ],
        30,
        0,
    );
    health.beat("rpc0", 42, crate::event::now_secs());
    let (tx, _) = broadcast::channel(16);
    api_router(
        ApiState {
            store: store.clone(),
            health,
            stream: tx,
            token: token.map(String::from),
        },
        &["http://localhost:3000".into()],
    )
    .unwrap()
}

async fn call(
    app: &axum::Router,
    method: &str,
    uri: &str,
    auth: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(uri);
    if let Some(a) = auth {
        req = req.header("authorization", a);
    }
    let req = req
        .header("content-type", "application/json")
        .body(
            body.map(|b| Body::from(b.to_string()))
                .unwrap_or_else(Body::empty),
        )
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn assert_error(v: &Value, code: &str) {
    assert_eq!(keys(v), sorted(&["error"]));
    assert_eq!(keys(&v["error"]), sorted(&["code", "message"]));
    assert_eq!(v["error"]["code"], code);
}

fn hold(owner: u8, status: u8) -> PendingWithdrawal {
    PendingWithdrawal {
        bump: 1,
        config: Pk([1; 32]),
        owner: Pk([owner; 32]),
        mint: Pk([3; 32]),
        amount: u64::MAX,
        nonce: 18_000_000_000_000_000_000,
        created_at: 1_800_000_000,
        release_at: 1_800_021_600,
        status,
        scope: 1,
        kind: 0,
    }
}

// ---- router -------------------------------------------------------------------

#[sqlx::test(migrations = "./migrations")]
async fn one_incident_per_root_cause_pages_on_new_and_on_severity_rise(pool: PgPool) {
    let (store, pid, router, seen) = setup(pool).await;
    router.handle(signal(Severity::High, "k", Some("s1"))).await;
    router
        .handle(signal(Severity::Warning, "k", Some("s2")))
        .await;
    router.handle(signal(Severity::High, "k", Some("s2"))).await;
    let alerts = wait_alerts(&seen, 1).await;
    assert_eq!(
        alerts.len(),
        1,
        "same root cause, same or lower severity: no new page"
    );
    assert_eq!(alerts[0].tx_link.as_deref(), Some("https://x/tx/s1"));

    router
        .handle(signal(Severity::Critical, "k", Some("s3")))
        .await;
    let alerts = wait_alerts(&seen, 2).await;
    assert_eq!(alerts.len(), 2);
    let inc = store.active_incident(pid, "k").await.unwrap().unwrap();
    assert_eq!(inc.severity, "critical");
    assert_eq!(inc.signatures, vec!["s1", "s2", "s3"]);
    let recorded = store.incident_alerts(inc.num_id()).await.unwrap();
    assert_eq!(recorded.len(), 2);
    assert!(recorded.iter().all(|a| a.ok && a.sink == "stdout"));
}

#[sqlx::test(migrations = "./migrations")]
async fn critical_evidence_after_an_ack_reopens_and_pages(pool: PgPool) {
    let (store, pid, router, seen) = setup(pool).await;
    router.handle(signal(Severity::Critical, "bal", None)).await;
    let id = store
        .active_incident(pid, "bal")
        .await
        .unwrap()
        .unwrap()
        .num_id();
    store.ack(id, "alice", None).await.unwrap();
    router.handle(signal(Severity::High, "bal", None)).await;
    assert_eq!(
        wait_alerts(&seen, 1).await.len(),
        1,
        "High after ack: attach quietly"
    );
    router.handle(signal(Severity::Critical, "bal", None)).await;
    assert_eq!(wait_alerts(&seen, 2).await.len(), 2);
    let inc = store.incident(id).await.unwrap().unwrap();
    assert_eq!((inc.status.as_str(), inc.acked_by), ("open", None));
}

#[sqlx::test(migrations = "./migrations")]
async fn unacked_critical_repages_and_escalates(pool: PgPool) {
    let (store, pid, router, seen) = setup(pool.clone()).await;
    router
        .handle(signal(Severity::Critical, "trip:1", Some("s")))
        .await;
    router.handle(signal(Severity::High, "pause:1", None)).await;
    wait_alerts(&seen, 2).await;
    router.tick().await;
    assert_eq!(wait_alerts(&seen, 3).await.len(), 2, "not due yet");

    sqlx::query("UPDATE incidents SET opened_at = now() - interval '400 seconds', last_paged_at = now() - interval '130 seconds'")
        .execute(&pool)
        .await
        .unwrap();
    router.tick().await;
    let alerts = wait_alerts(&seen, 3).await;
    assert_eq!(alerts.len(), 3, "only the Critical one re-pages");
    let re = &alerts[2];
    assert_eq!(
        (re.severity, re.repage, re.escalated),
        (Severity::Critical, 1, true)
    );
    assert!(re.line().contains("[ESCALATED][re-page #1]"));
    router.tick().await;
    assert_eq!(wait_alerts(&seen, 4).await.len(), 3, "just re-paged");

    // Acked: never re-paged.
    let inc = store.active_incident(pid, "trip:1").await.unwrap().unwrap();
    store.ack(inc.num_id(), "bob", Some("on it")).await.unwrap();
    sqlx::query("UPDATE incidents SET last_paged_at = now() - interval '500 seconds'")
        .execute(&pool)
        .await
        .unwrap();
    router.tick().await;
    assert_eq!(wait_alerts(&seen, 4).await.len(), 3);
}

#[sqlx::test(migrations = "./migrations")]
async fn a_failing_sink_is_recorded_and_doesnt_stop_others(pool: PgPool) {
    struct Broken;
    #[async_trait]
    impl AlertSink for Broken {
        fn name(&self) -> &'static str {
            "webhook"
        }
        async fn send(&self, _: &Alert) -> anyhow::Result<()> {
            anyhow::bail!("down")
        }
    }
    let store = Store::from_pool(pool).await.unwrap();
    let pid = store.protocol("p", "BG", "TV").await.unwrap();
    let seen = Arc::new(Mutex::new(vec![]));
    let mut sinks: Sinks = Default::default();
    sinks.insert("stdout".into(), Arc::new(Capture(seen.clone())));
    sinks.insert("webhook".into(), Arc::new(Broken));
    let mut cfg = alert_cfg();
    cfg.sinks = vec!["stdout".into(), "webhook".into()];
    let (tx, _) = broadcast::channel(16);
    let router = Router::new(store.clone(), pid, "p".into(), cfg, sinks, tx);
    router.handle(signal(Severity::Critical, "x", None)).await;
    assert_eq!(wait_alerts(&seen, 1).await.len(), 1);
    let id = store
        .active_incident(pid, "x")
        .await
        .unwrap()
        .unwrap()
        .num_id();
    for _ in 0..50 {
        if store.incident_alerts(id).await.unwrap().len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let mut a = store.incident_alerts(id).await.unwrap();
    a.sort_by(|x, y| x.sink.cmp(&y.sink));
    assert_eq!(
        a.iter()
            .map(|x| (x.sink.as_str(), x.ok))
            .collect::<Vec<_>>(),
        vec![("stdout", true), ("webhook", false)]
    );
}

// ---- API: one test per endpoint -------------------------------------------------

#[sqlx::test(migrations = "./migrations")]
async fn get_health(pool: PgPool) {
    let store = Store::from_pool(pool).await.unwrap();
    let (st, v) = call(&api(&store, None).await, "GET", "/health", None, None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(keys(&v), sorted(&["status", "rpc"]));
    assert_eq!(v["status"], "degraded", "rpc1 never sent a heartbeat");
    let r0 = &v["rpc"][0];
    assert_eq!(keys(r0), sorted(&["url", "last_slot", "lag_secs", "alive"]));
    assert_eq!(
        (
            r0["url"].as_str(),
            r0["last_slot"].as_u64(),
            r0["alive"].as_bool()
        ),
        (Some("http://a"), Some(42), Some(true))
    );
    assert_eq!(v["rpc"][1]["alive"], false);
}

#[sqlx::test(migrations = "./migrations")]
async fn get_incidents(pool: PgPool) {
    let (store, pid, _, _) = setup(pool).await;
    for i in 0..3 {
        store
            .create_incident(
                pid,
                "d",
                Severity::High,
                &format!("t{i}"),
                &format!("k{i}"),
                Some("sig"),
            )
            .await
            .unwrap();
    }
    let app = api(&store, None).await;
    let (st, v) = call(&app, "GET", "/incidents?limit=2", None, None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(keys(&v), sorted(&["items", "next_cursor"]));
    let items = v["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    items.iter().for_each(assert_incident_shape);
    assert_eq!(items[0]["title"], "t2", "newest first");
    assert_eq!(items[0]["protocol"], "test-vault");
    let cursor = v["next_cursor"].as_str().unwrap().to_string();
    let (_, v2) = call(
        &app,
        "GET",
        &format!("/incidents?limit=2&cursor={cursor}"),
        None,
        None,
    )
    .await;
    assert_eq!(v2["items"].as_array().unwrap().len(), 1);
    assert_eq!(v2["next_cursor"], Value::Null);

    let (_, open) = call(&app, "GET", "/incidents?status=acked", None, None).await;
    assert_eq!(open["items"].as_array().unwrap().len(), 0);
    let (st, err) = call(&app, "GET", "/incidents?status=bogus", None, None).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert_error(&err, "bad_request");
    let (st, err) = call(&app, "GET", "/incidents?limit=501", None, None).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert_error(&err, "bad_request");
}

#[sqlx::test(migrations = "./migrations")]
async fn get_incident_by_id(pool: PgPool) {
    let (store, pid, _, _) = setup(pool).await;
    let inc = store
        .create_incident(
            pid,
            "large_withdrawal",
            Severity::High,
            "held",
            "hold:H",
            Some("SIG"),
        )
        .await
        .unwrap();
    store
        .insert_event(
            pid,
            "LargeWithdrawalQueued",
            "SIG",
            0,
            77,
            Some(1_800_000_000),
            &json!({"amount": "500"}),
        )
        .await
        .unwrap();
    store
        .record_alert(Some(inc.num_id()), "stdout", true, None)
        .await
        .unwrap();
    let app = api(&store, None).await;
    let (st, v) = call(&app, "GET", &format!("/incidents/{}", inc.id), None, None).await;
    assert_eq!(st, StatusCode::OK);
    let mut expected: Vec<&str> = INCIDENT_KEYS.to_vec();
    expected.extend(["events", "alerts"]);
    assert_eq!(keys(&v), sorted(&expected));
    let ev = &v["events"][0];
    assert_eq!(
        keys(ev),
        sorted(&["id", "kind", "signature", "slot", "block_time", "data"])
    );
    assert_eq!(
        (ev["kind"].as_str(), ev["slot"].as_i64()),
        (Some("LargeWithdrawalQueued"), Some(77))
    );
    assert_eq!(ev["data"]["amount"], "500");
    assert!(chrono::DateTime::parse_from_rfc3339(ev["block_time"].as_str().unwrap()).is_ok());
    let al = &v["alerts"][0];
    assert_eq!(keys(al), sorted(&["id", "sink", "sent_at", "ok"]));
    assert_eq!(al["ok"], true);

    let (st, err) = call(&app, "GET", "/incidents/999999", None, None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert_error(&err, "not_found");
    let (st, _) = call(&app, "GET", "/incidents/abc", None, None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
}

#[sqlx::test(migrations = "./migrations")]
async fn post_incident_ack(pool: PgPool) {
    let (store, pid, _, _) = setup(pool).await;
    let inc = store
        .create_incident(pid, "d", Severity::Critical, "t", "k", None)
        .await
        .unwrap();
    let uri = format!("/incidents/{}/ack", inc.id);
    let body = json!({ "by": "alice", "note": "looking" });

    // Acks disabled when no token is configured.
    let off = api(&store, None).await;
    let (st, err) = call(
        &off,
        "POST",
        &uri,
        Some("Bearer anything"),
        Some(body.clone()),
    )
    .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert_error(&err, "unauthorized");

    let app = api(&store, Some("t0ken")).await;
    for auth in [
        None,
        Some("Bearer wrong"),
        Some("t0ken"),
        Some("Bearer t0ke"),
    ] {
        let (st, err) = call(&app, "POST", &uri, auth, Some(body.clone())).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED, "{auth:?}");
        assert_error(&err, "unauthorized");
    }
    let (st, err) = call(
        &app,
        "POST",
        &uri,
        Some("Bearer t0ken"),
        Some(json!({ "note": "no by" })),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert_error(&err, "bad_request");

    let (st, v) = call(&app, "POST", &uri, Some("Bearer t0ken"), Some(body.clone())).await;
    assert_eq!(st, StatusCode::OK);
    assert_incident_shape(&v);
    assert_eq!(
        (v["status"].as_str(), v["acked_by"].as_str()),
        (Some("acked"), Some("alice"))
    );
    assert!(chrono::DateTime::parse_from_rfc3339(v["acked_at"].as_str().unwrap()).is_ok());

    let (st, err) = call(&app, "POST", &uri, Some("Bearer t0ken"), Some(body.clone())).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_error(&err, "conflict");
    let (st, err) = call(
        &app,
        "POST",
        "/incidents/424242/ack",
        Some("Bearer t0ken"),
        Some(body),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert_error(&err, "not_found");
    let acks: i64 = sqlx::query_scalar("SELECT count(*) FROM acks")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(acks, 1);
}

#[sqlx::test(migrations = "./migrations")]
async fn get_holds(pool: PgPool) {
    let (store, pid, _, _) = setup(pool).await;
    store.upsert_hold(pid, "HOLD1", &hold(2, 0)).await.unwrap();
    store.upsert_hold(pid, "HOLD2", &hold(4, 1)).await.unwrap();
    store.upsert_hold(pid, "HOLD1", &hold(2, 4)).await.unwrap(); // claimed later
    let app = api(&store, None).await;
    let owner = Pk([2; 32]).to_string();
    let (st, v) = call(&app, "GET", &format!("/holds?owner={owner}"), None, None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(keys(&v), sorted(&["items", "next_cursor"]));
    let items = v["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    let h = &items[0];
    assert_eq!(
        keys(h),
        sorted(&[
            "address",
            "owner",
            "mint",
            "amount",
            "nonce",
            "created_at",
            "release_at",
            "status"
        ])
    );
    assert_eq!(
        h["amount"],
        u64::MAX.to_string(),
        "u64 amounts are exact decimal strings"
    );
    assert_eq!(h["nonce"], "18000000000000000000");
    assert_eq!(h["status"], "claimed");
    assert!(chrono::DateTime::parse_from_rfc3339(h["release_at"].as_str().unwrap()).is_ok());

    let (_, frozen) = call(&app, "GET", "/holds?status=frozen", None, None).await;
    assert_eq!(frozen["items"][0]["address"], "HOLD2");
    let (st, err) = call(&app, "GET", "/holds?status=lost", None, None).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert_error(&err, "bad_request");
}

#[sqlx::test(migrations = "./migrations")]
async fn get_events(pool: PgPool) {
    let (store, pid, _, _) = setup(pool).await;
    store
        .insert_event(
            pid,
            "Paused",
            "S1",
            0,
            10,
            Some(1_700_000_000),
            &json!({"scopesMask": "2"}),
        )
        .await
        .unwrap();
    store
        .insert_event(
            pid,
            "Unpaused",
            "S2",
            0,
            11,
            Some(1_800_000_000),
            &json!({}),
        )
        .await
        .unwrap();
    let dup = store
        .insert_event(pid, "Paused", "S1", 0, 10, Some(1_700_000_000), &json!({}))
        .await
        .unwrap();
    assert!(dup.is_none(), "deduped by (signature, index)");
    let app = api(&store, None).await;
    let (st, v) = call(&app, "GET", "/events", None, None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(keys(&v), sorted(&["items", "next_cursor"]));
    assert_eq!(v["items"].as_array().unwrap().len(), 2);
    assert_eq!(
        keys(&v["items"][0]),
        sorted(&["id", "kind", "signature", "slot", "block_time", "data"])
    );
    let (_, paused) = call(&app, "GET", "/events?kind=Paused", None, None).await;
    assert_eq!(paused["items"][0]["data"]["scopesMask"], "2");
    let (_, recent) = call(
        &app,
        "GET",
        "/events?since=2026-01-01T00:00:00Z",
        None,
        None,
    )
    .await;
    assert_eq!(recent["items"].as_array().unwrap().len(), 1);
    assert_eq!(recent["items"][0]["kind"], "Unpaused");
    let (st, err) = call(&app, "GET", "/events?since=yesterday", None, None).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert_error(&err, "bad_request");
}

#[sqlx::test(migrations = "./migrations")]
async fn get_stream_and_unknown_paths(pool: PgPool) {
    let store = Store::from_pool(pool).await.unwrap();
    let health = Health::new(vec![], 30, 0);
    let (tx, _) = broadcast::channel(16);
    let app = api_router(
        ApiState {
            store: store.clone(),
            health,
            stream: tx.clone(),
            token: None,
        },
        &[],
    )
    .unwrap();
    let res = app
        .clone()
        .oneshot(Request::get("/stream").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["content-type"], "text/event-stream");
    let mut body = res.into_body();
    tx.send(crate::router::StreamMsg {
        kind: "incident",
        data: json!({"id": "1"}),
    })
    .unwrap();
    let frame = tokio::time::timeout(Duration::from_secs(2), body.frame())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let text = String::from_utf8(frame.into_data().unwrap().to_vec()).unwrap();
    let payload: Value = serde_json::from_str(text.trim().strip_prefix("data: ").unwrap()).unwrap();
    assert_eq!(
        payload,
        json!({ "type": "incident", "data": { "id": "1" } })
    );

    let (st, err) = call(&app, "GET", "/nope", None, None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert_error(&err, "not_found");
}

#[sqlx::test(migrations = "./migrations")]
async fn cors_only_for_configured_origins(pool: PgPool) {
    let store = Store::from_pool(pool).await.unwrap();
    let app = api(&store, None).await;
    let req = |origin: &str| {
        Request::get("/health")
            .header("origin", origin)
            .body(Body::empty())
            .unwrap()
    };
    let ok = app
        .clone()
        .oneshot(req("http://localhost:3000"))
        .await
        .unwrap();
    assert_eq!(
        ok.headers()["access-control-allow-origin"],
        "http://localhost:3000"
    );
    let other = app
        .clone()
        .oneshot(req("http://evil.example"))
        .await
        .unwrap();
    assert!(other.headers().get("access-control-allow-origin").is_none());
}
