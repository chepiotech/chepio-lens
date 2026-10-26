// Core
use std::convert::Infallible;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use serde::Deserialize;
// Domain
use crate::domain::activity::{ActivityId, ActivityQuery, Origin};
use crate::domain::log::{Layer, LogCursor, LogKind, LogQuery, StatusFilter};
use crate::domain::log_record::LogLevel;
use crate::domain::span::TraceId;
// Handlers
use super::AppState;
// Types
use crate::types::FeedItem;
use crate::types::api::{
    ActivityDetailView, ActivityPageView, ActivityView, EdgeView, GraphView, LensEventName,
    LogEntryView, LogPageView, NodeView, RequestDetailView, StatsView, cursor_text, parse_cursor,
};
// Consts
use crate::consts::{ACTIVITY_PAGE_DEFAULT, ACTIVITY_PAGE_MAX, LOG_PAGE_DEFAULT, LOG_PAGE_MAX};

pub(super) async fn graph(State(state): State<Arc<AppState>>) -> Json<GraphView> {
    let snapshot = state.query.graph(state.clock.now());
    Json(GraphView {
        nodes: snapshot.nodes.iter().map(NodeView::from).collect(),
        edges: snapshot.edges.iter().map(EdgeView::from).collect(),
        generated_at: snapshot.generated_at_ns.to_string(),
    })
}

/// SSE stream of `node`, `edge`, `request`, `log`, `activity` and `resync` events; 503 once the client bound is reached.
pub(super) async fn events(State(state): State<Arc<AppState>>) -> Response {
    let Ok(permit) = state.sse_permits.clone().try_acquire_owned() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "too many event streams").into_response();
    };
    let stream = state.query.subscribe().map(move |item| {
        // The permit lives as long as the stream, so a closed tab frees its slot.
        let _slot = &permit;
        Ok::<_, Infallible>(match item {
            FeedItem::Event(event) => Event::default().event(event.name).data(event.data.as_str()),
            FeedItem::Resync => Event::default()
                .event(LensEventName::Resync.as_str())
                .data("{}"),
        })
    });
    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

/// Query string of `GET /api/logs` (`docs/architecture/interfaces.md`, UI API).
#[derive(Debug, Default, Deserialize)]
pub(super) struct LogParams {
    /// Comma-separated: `frontend`, `backend`, `database`.
    layer: Option<String>,
    node: Option<String>,
    edge: Option<String>,
    /// `ok` or `error`.
    status: Option<String>,
    level: Option<String>,
    kind: Option<String>,
    q: Option<String>,
    limit: Option<usize>,
    /// An entry id from an earlier page.
    before: Option<String>,
}

/// Comma-separated values, trimmed, empty ones skipped.
fn list(value: Option<&str>) -> impl Iterator<Item = &str> {
    value
        .into_iter()
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .filter(|item| !item.is_empty())
}

fn layers(value: Option<&str>) -> Result<Vec<Layer>, String> {
    list(value)
        .map(|layer| match layer {
            "frontend" => Ok(Layer::Frontend),
            "backend" => Ok(Layer::Backend),
            "database" => Ok(Layer::Database),
            other => Err(format!(
                "unknown layer {other:?}; use frontend, backend or database"
            )),
        })
        .collect()
}

fn status(value: Option<&str>) -> Result<Option<StatusFilter>, String> {
    match value {
        None | Some("") => Ok(None),
        Some("ok") => Ok(Some(StatusFilter::Ok)),
        Some("error") => Ok(Some(StatusFilter::Error)),
        Some(other) => Err(format!("unknown status {other:?}; use ok or error")),
    }
}

fn before(value: Option<&str>) -> Result<Option<LogCursor>, String> {
    match value {
        None | Some("") => Ok(None),
        Some(text) => parse_cursor(text)
            .map(Some)
            .ok_or_else(|| format!("before={text:?} is not a cursor")),
    }
}

fn some(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty())
}

impl LogParams {
    fn query(self) -> Result<LogQuery, String> {
        let layers = layers(self.layer.as_deref())?;
        let status = status(self.status.as_deref())?;
        let levels = self
            .level
            .iter()
            .flat_map(|value| value.split(','))
            .filter(|v| !v.is_empty())
            .map(|value| {
                LogLevel::parse(value.trim()).ok_or_else(|| "unknown log level".to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let kinds = self
            .kind
            .iter()
            .flat_map(|value| value.split(','))
            .filter(|v| !v.is_empty())
            .map(|value| match value.trim() {
                "log" => Ok(LogKind::Log),
                "action" => Ok(LogKind::Action),
                "request" => Ok(LogKind::Request),
                "query" => Ok(LogKind::Query),
                "call" => Ok(LogKind::Call),
                "span" => Ok(LogKind::Span),
                _ => Err("unknown log kind".to_owned()),
            })
            .collect::<Result<Vec<_>, _>>()?;
        let before = before(self.before.as_deref())?;
        Ok(LogQuery {
            layers,
            node: some(self.node),
            edge: some(self.edge),
            status,
            levels,
            kinds,
            text: some(self.q),
            before,
            limit: self
                .limit
                .unwrap_or(LOG_PAGE_DEFAULT)
                .clamp(1, LOG_PAGE_MAX),
        })
    }
}

/// Log lines, newest first, filtered; `400` for unknown filter values.
pub(super) async fn logs(
    State(state): State<Arc<AppState>>,
    Query(params): Query<LogParams>,
) -> Response {
    let query = match params.query() {
        Ok(query) => query,
        Err(message) => return (StatusCode::BAD_REQUEST, message).into_response(),
    };
    let page = state.query.logs(&query);
    Json(LogPageView {
        entries: page.entries.iter().map(LogEntryView::from).collect(),
        next_before: page.next_before.map(cursor_text),
    })
    .into_response()
}

/// Query string of `GET /api/activities`: the filters of `GET /api/logs` without level and kind, plus `origin`.
#[derive(Debug, Default, Deserialize)]
pub(super) struct ActivityParams {
    layer: Option<String>,
    node: Option<String>,
    edge: Option<String>,
    status: Option<String>,
    /// Comma-separated: `action`, `request`.
    origin: Option<String>,
    q: Option<String>,
    limit: Option<usize>,
    /// A `cursor` from an earlier page.
    before: Option<String>,
}

impl ActivityParams {
    fn query(self) -> Result<ActivityQuery, String> {
        let origins = list(self.origin.as_deref())
            .map(|origin| match origin {
                "action" => Ok(Origin::Action),
                "request" => Ok(Origin::Request),
                other => Err(format!("unknown origin {other:?}; use action or request")),
            })
            .collect::<Result<_, _>>()?;
        Ok(ActivityQuery {
            layers: layers(self.layer.as_deref())?,
            node: some(self.node),
            edge: some(self.edge),
            status: status(self.status.as_deref())?,
            origins,
            text: some(self.q),
            before: before(self.before.as_deref())?,
            limit: self
                .limit
                .unwrap_or(ACTIVITY_PAGE_DEFAULT)
                .clamp(1, ACTIVITY_PAGE_MAX),
        })
    }
}

/// Activities, newest first, filtered; `400` for unknown filter values.
pub(super) async fn activities(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ActivityParams>,
) -> Response {
    let query = match params.query() {
        Ok(query) => query,
        Err(message) => return (StatusCode::BAD_REQUEST, message).into_response(),
    };
    let page = state.query.activities(&query);
    Json(ActivityPageView {
        activities: page.activities.iter().map(ActivityView::from).collect(),
        next_before: page.next_before.map(cursor_text),
    })
    .into_response()
}

/// One activity with its steps; `404` once it has been evicted or reset.
pub(super) async fn activity(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let Some(id) = ActivityId::parse(&id) else {
        return (
            StatusCode::BAD_REQUEST,
            "an activity id is action:<id> or trace:<32 hex digits>",
        )
            .into_response();
    };
    match state.query.activity(&id) {
        Some(detail) => Json(ActivityDetailView::from(&detail)).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            "this activity is no longer in memory",
        )
            .into_response(),
    }
}

/// One request with all its spans; `404` once it has been evicted or reset.
pub(super) async fn request(
    State(state): State<Arc<AppState>>,
    Path(trace_id): Path<String>,
) -> Response {
    let Some(trace_id) = TraceId::from_hex(&trace_id) else {
        return (StatusCode::BAD_REQUEST, "a trace id is 32 hex digits").into_response();
    };
    match state.query.request(&trace_id) {
        Some(detail) => Json(RequestDetailView::from(&detail)).into_response(),
        None => (StatusCode::NOT_FOUND, "this request is no longer in memory").into_response(),
    }
}

pub(super) async fn reset(State(state): State<Arc<AppState>>) -> StatusCode {
    state.ingest.reset();
    StatusCode::NO_CONTENT
}

pub(super) async fn stats(State(state): State<Arc<AppState>>) -> Json<StatsView> {
    Json(StatsView {
        batches_busy: state.batches_busy.load(Ordering::Relaxed),
        sse_clients: state.limits.max_sse_clients - state.sse_permits.available_permits(),
        ..state.query.stats()
    })
}

pub(super) async fn healthz() -> &'static str {
    "ok"
}
