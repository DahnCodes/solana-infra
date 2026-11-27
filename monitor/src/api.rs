//! Admin HTTP API: exactly the contract in docs/FRONTEND.md section 7.
//! JSON errors `{ "error": { "code", "message" } }`, cursor pagination
//! `{ "items", "next_cursor" }`, amounts as decimal strings, RFC 3339 times.
//! Read endpoints are open; `POST /incidents/:id/ack` needs
//! `Authorization: Bearer <MONITOR_API_TOKEN>`. The API never signs anything.

use std::collections::HashMap;
use std::convert::Infallible;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::stream::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::event::now_secs;
use crate::health::{Health, RpcHealth};
use crate::router::StreamMsg;
use crate::store::{AckError, Alert, Event, Hold, Incident, Page, Store};

#[derive(Clone)]
pub struct ApiState {
    pub store: Store,
    pub health: Health,
    pub stream: broadcast::Sender<StreamMsg>,
    /// None or empty: acks are disabled (every ack gets 401).
    pub token: Option<String>,
}

pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
    fn bad(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", message)
    }
    fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", message)
    }
    fn internal(e: impl std::fmt::Display) -> Self {
        tracing::error!(error = %e, "api error");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal error",
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({ "error": { "code": self.code, "message": self.message } })),
        )
            .into_response()
    }
}

type ApiResult<T> = Result<Json<T>, ApiError>;

#[derive(Serialize)]
pub struct List<T> {
    items: Vec<T>,
    next_cursor: Option<String>,
}

impl<T> From<Page<T>> for List<T> {
    fn from(p: Page<T>) -> Self {
        Self {
            items: p.items,
            next_cursor: p.next_cursor,
        }
    }
}

#[derive(Serialize)]
struct HealthBody {
    status: &'static str,
    rpc: Vec<RpcHealth>,
}

#[derive(Serialize)]
struct IncidentDetail {
    #[serde(flatten)]
    incident: Incident,
    events: Vec<Event>,
    alerts: Vec<Alert>,
}

#[derive(Deserialize)]
struct AckBody {
    by: String,
    note: Option<String>,
}

const MAX_LIMIT: i64 = 500;
const DEFAULT_LIMIT: i64 = 50;

fn paging(q: &HashMap<String, String>) -> Result<(i64, Option<i64>), ApiError> {
    let limit = match q.get("limit") {
        None => DEFAULT_LIMIT,
        Some(v) => v
            .parse::<i64>()
            .ok()
            .filter(|l| (1..=MAX_LIMIT).contains(l))
            .ok_or_else(|| ApiError::bad(format!("limit must be 1..={MAX_LIMIT}")))?,
    };
    let cursor = match q.get("cursor") {
        None => None,
        Some(c) if c.is_empty() => None,
        Some(c) => Some(
            c.parse::<i64>()
                .map_err(|_| ApiError::bad("invalid cursor"))?,
        ),
    };
    Ok((limit, cursor))
}

fn one_of<'a>(
    q: &'a HashMap<String, String>,
    key: &str,
    allowed: &[&str],
) -> Result<Option<&'a str>, ApiError> {
    match q.get(key).map(String::as_str) {
        None | Some("") => Ok(None),
        Some(v) if allowed.contains(&v) => Ok(Some(v)),
        Some(v) => Err(ApiError::bad(format!(
            "{key} must be one of {} (got {v})",
            allowed.join(", ")
        ))),
    }
}

async fn health(State(s): State<ApiState>) -> Json<HealthBody> {
    let (ok, rpc) = s.health.report(now_secs());
    Json(HealthBody {
        status: if ok { "ok" } else { "degraded" },
        rpc,
    })
}

async fn incidents(
    State(s): State<ApiState>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<List<Incident>> {
    let (limit, cursor) = paging(&q)?;
    let status = one_of(&q, "status", &["open", "acked", "resolved"])?;
    Ok(Json(
        s.store
            .list_incidents(status, limit, cursor)
            .await
            .map_err(ApiError::internal)?
            .into(),
    ))
}

fn incident_id(id: &str) -> Result<i64, ApiError> {
    id.parse()
        .map_err(|_| ApiError::not_found(format!("no incident {id}")))
}

async fn incident(State(s): State<ApiState>, Path(id): Path<String>) -> ApiResult<IncidentDetail> {
    let id = incident_id(&id)?;
    let inc = s
        .store
        .incident(id)
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::not_found(format!("no incident {id}")))?;
    let events = s
        .store
        .incident_events(&inc)
        .await
        .map_err(ApiError::internal)?;
    let alerts = s
        .store
        .incident_alerts(id)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(IncidentDetail {
        incident: inc,
        events,
        alerts,
    }))
}

/// Constant-time equality, so the token can't be guessed byte by byte.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn ack(
    State(s): State<ApiState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Incident> {
    let unauthorized = || {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or wrong bearer token",
        )
    };
    let token = s
        .token
        .as_deref()
        .filter(|t| !t.is_empty())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "acks are disabled: set MONITOR_API_TOKEN",
            )
        })?;
    let given = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(unauthorized)?;
    if !same(given.as_bytes(), token.as_bytes()) {
        return Err(unauthorized());
    }
    let id = incident_id(&id)?;
    let b: AckBody = serde_json::from_slice(&body).map_err(|e| {
        ApiError::bad(format!(
            "body must be {{\"by\": string, \"note\"?: string}}: {e}"
        ))
    })?;
    let by = b.by.trim();
    if by.is_empty() || by.len() > 200 {
        return Err(ApiError::bad("by must be 1-200 characters"));
    }
    match s.store.ack(id, by, b.note.as_deref()).await {
        Ok(inc) => {
            let _ = s.stream.send(StreamMsg {
                kind: "incident",
                data: serde_json::to_value(&inc).unwrap_or_default(),
            });
            Ok(Json(inc))
        }
        Err(AckError::NotFound) => Err(ApiError::not_found(format!("no incident {id}"))),
        Err(AckError::NotOpen(st)) => Err(ApiError::new(
            StatusCode::CONFLICT,
            "conflict",
            format!("incident is already {st}"),
        )),
        Err(AckError::Db(e)) => Err(ApiError::internal(e)),
    }
}

async fn holds(
    State(s): State<ApiState>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<List<Hold>> {
    let (limit, cursor) = paging(&q)?;
    let status = one_of(
        &q,
        "status",
        &["queued", "frozen", "released", "rejected", "claimed"],
    )?;
    let owner = q.get("owner").map(String::as_str).filter(|o| !o.is_empty());
    Ok(Json(
        s.store
            .list_holds(owner, status, limit, cursor)
            .await
            .map_err(ApiError::internal)?
            .into(),
    ))
}

async fn events(
    State(s): State<ApiState>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<List<Event>> {
    let (limit, cursor) = paging(&q)?;
    let kind = q.get("kind").map(String::as_str).filter(|k| !k.is_empty());
    let since = match q.get("since").filter(|v| !v.is_empty()) {
        None => None,
        Some(v) => Some(
            chrono::DateTime::parse_from_rfc3339(v)
                .map_err(|_| ApiError::bad("since must be an RFC 3339 time"))?
                .with_timezone(&chrono::Utc),
        ),
    };
    Ok(Json(
        s.store
            .list_events(kind, since, limit, cursor)
            .await
            .map_err(ApiError::internal)?
            .into(),
    ))
}

async fn stream(
    State(s): State<ApiState>,
) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    let rx = BroadcastStream::new(s.stream.subscribe());
    let events = rx.filter_map(|m| async move {
        let m = m.ok()?; // a lagging client skips what it missed
        Some(Ok(SseEvent::default().data(serde_json::to_string(&m).ok()?)))
    });
    Sse::new(events).keep_alive(KeepAlive::default())
}

async fn not_found() -> ApiError {
    ApiError::not_found("no such endpoint")
}

pub fn router(state: ApiState, cors_origins: &[String]) -> anyhow::Result<Router> {
    let mut app = Router::new()
        .route("/health", get(health))
        .route("/incidents", get(incidents))
        .route("/incidents/{id}", get(incident))
        .route("/incidents/{id}/ack", post(ack))
        .route("/holds", get(holds))
        .route("/events", get(events))
        .route("/stream", get(stream))
        .fallback(not_found)
        .with_state(state);
    if !cors_origins.is_empty() {
        let origins = cors_origins
            .iter()
            .map(|o| HeaderValue::from_str(o))
            .collect::<Result<Vec<_>, _>>()?;
        app = app.layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::list(origins))
                .allow_methods([Method::GET, Method::POST])
                .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]),
        );
    }
    Ok(app)
}
