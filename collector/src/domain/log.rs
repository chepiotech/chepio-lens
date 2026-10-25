//! Log entries for the logs panel: every span as one line, tagged with the layer it belongs to. Built at ingest from
//! normalized spans; the line text holds only values that were already redacted (I2).

// Core
use chepio_lens_conventions::keys::{
    DB_QUERY_TEXT, HTTP_REQUEST_METHOD, HTTP_RESPONSE_STATUS_CODE, URL_FULL,
};
// Domain
use super::linker::db_target;
use super::log_record::{LogLevel, LogRecord};
use super::node::{DbTarget, service_node_id};
use super::span::{ServiceKind, Span, SpanId, SpanKind, TraceId};

/// Longest line text kept; SQL and URLs are cut here, the inspector shows them whole.
const MAX_TEXT_CHARS: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Layer {
    Frontend,
    Backend,
    Database,
}

impl Layer {
    /// `Database` for a query, `Frontend` for a span of a frontend node, `Backend` otherwise.
    pub fn of(span: &Span) -> Self {
        match (database_of(span), span.service.kind) {
            (Some(_), _) => Self::Database,
            (None, ServiceKind::Frontend) => Self::Frontend,
            (None, ServiceKind::Service) => Self::Backend,
        }
    }
}

/// The database a client span queried.
fn database_of(span: &Span) -> Option<DbTarget> {
    db_target(span).filter(|_| span.kind == SpanKind::Client)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogKind {
    /// A browser fetch, or a request a backend handled.
    Request,
    /// A database query.
    Query,
    /// A call from a backend to another service or host.
    Call,
    /// Any other span.
    Span,
    Log,
    Action,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LogEntry {
    /// Arrival order; breaks ties between entries with the same time.
    pub seq: u64,
    pub trace_id: Option<TraceId>,
    pub span_id: Option<SpanId>,
    /// Retained for edge filtering: only a server span can represent the callee of a client span.
    pub span_kind: SpanKind,
    pub parent_span_id: Option<SpanId>,
    pub time_ns: u64,
    pub duration_ns: u64,
    pub layer: Layer,
    pub kind: LogKind,
    pub service: String,
    /// The emitting service's node and, for queries, the database node.
    pub nodes: Vec<String>,
    pub text: String,
    pub status_code: Option<u16>,
    pub error: bool,
    pub level: Option<LogLevel>,
    pub record: Option<Box<LogRecord>>,
    /// Lowercase text, service and trace id, for search.
    pub search: String,
}

impl LogEntry {
    pub fn from_span(span: &Span, seq: u64) -> Self {
        let database = database_of(span);
        let layer = Layer::of(span);
        let status_code = span
            .attr_i64(HTTP_RESPONSE_STATUS_CODE)
            .and_then(|code| u16::try_from(code).ok());
        let (kind, text) = match (&database, span.kind) {
            (Some(_), _) => (
                LogKind::Query,
                span.attr_str(DB_QUERY_TEXT)
                    .map(one_line)
                    .unwrap_or_else(|| span.name.clone()),
            ),
            (None, SpanKind::Server) => (LogKind::Request, span.name.clone()),
            (None, SpanKind::Client) => {
                let target = match (span.attr_str(HTTP_REQUEST_METHOD), span.attr_str(URL_FULL)) {
                    (Some(method), Some(url)) => format!("{method} {}", short_url(url)),
                    _ => span.name.clone(),
                };
                let kind = match layer {
                    Layer::Frontend => LogKind::Request,
                    _ => LogKind::Call,
                };
                (kind, target)
            }
            _ => (LogKind::Span, span.name.clone()),
        };
        let text = cut(&text);
        let mut nodes = vec![service_node_id(&span.service.name)];
        if let Some(database) = &database {
            nodes.push(database.node_id());
        }
        Self {
            seq,
            trace_id: Some(span.trace_id),
            span_id: Some(span.span_id),
            span_kind: span.kind,
            parent_span_id: span.parent_span_id,
            time_ns: span.start_ns,
            duration_ns: span.duration_ns(),
            layer,
            kind,
            search: format!("{text} {} {}", span.service.name, span.trace_id).to_lowercase(),
            service: span.service.name.clone(),
            nodes,
            text,
            status_code,
            error: span.is_error(),
            level: None,
            record: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusFilter {
    Ok,
    Error,
}

/// Position in the log: entries are ordered by time, then arrival.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct LogCursor {
    pub time_ns: u64,
    pub seq: u64,
}

impl LogEntry {
    pub fn from_record(record: LogRecord, seq: u64) -> Self {
        let body = record.body.text();
        let kind = match record
            .attributes
            .get(chepio_lens_conventions::keys::LENS_LOG_KIND)
            .and_then(super::span::AttrValue::as_str)
        {
            Some("action") => LogKind::Action,
            _ => LogKind::Log,
        };
        Self {
            seq,
            trace_id: record.trace_id,
            span_id: record.span_id,
            span_kind: SpanKind::Unspecified,
            parent_span_id: None,
            time_ns: record.time_ns,
            duration_ns: 0,
            layer: match record.service.kind {
                ServiceKind::Frontend => Layer::Frontend,
                ServiceKind::Service => Layer::Backend,
            },
            kind,
            service: record.service.name.clone(),
            nodes: vec![service_node_id(&record.service.name)],
            text: cut(&one_line(&body)),
            status_code: None,
            error: matches!(record.level, Some(LogLevel::Error | LogLevel::Fatal)),
            search: format!(
                "{body} {} {}",
                record.service.name,
                record.trace_id.map(|id| id.to_string()).unwrap_or_default()
            )
            .to_lowercase(),
            level: record.level,
            record: Some(Box::new(record)),
        }
    }

    pub fn approx_size(&self) -> usize {
        192 + self.service.len()
            + self.text.len()
            + self.search.len()
            + self.nodes.iter().map(|id| id.len() + 24).sum::<usize>()
            + self
                .record
                .as_ref()
                .map_or(0, |record| record.approx_size())
    }

    pub fn cursor(&self) -> LogCursor {
        LogCursor {
            time_ns: self.time_ns,
            seq: self.seq,
        }
    }
}

/// Filters of the logs panel; empty fields match everything.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LogQuery {
    /// Layers to show; empty shows all.
    pub layers: Vec<Layer>,
    pub node: Option<String>,
    /// Edge id; matched through the spans that made the call (see `matches`).
    pub edge: Option<String>,
    pub status: Option<StatusFilter>,
    pub levels: Vec<LogLevel>,
    pub kinds: Vec<LogKind>,
    /// Case-insensitive substring of the line text, service or trace id.
    pub text: Option<String>,
    /// Only entries before this position (older), for paging.
    pub before: Option<LogCursor>,
    pub limit: usize,
}

impl LogQuery {
    /// `edge_spans`: trace and client span ids of the hops on `self.edge`. An entry belongs to the edge when it is
    /// such a client span or the server span it called within that trace.
    pub fn matches(
        &self,
        entry: &LogEntry,
        edge_spans: &std::collections::HashSet<(TraceId, SpanId)>,
    ) -> bool {
        (self.layers.is_empty() || self.layers.contains(&entry.layer))
            && self
                .node
                .as_ref()
                .is_none_or(|node| entry.nodes.contains(node))
            && (self.edge.is_none()
                || entry
                    .trace_id
                    .zip(entry.span_id)
                    .is_some_and(|ids| edge_spans.contains(&ids))
                || (entry.span_kind == SpanKind::Server
                    && entry.parent_span_id.is_some_and(|parent| {
                        entry
                            .trace_id
                            .is_some_and(|trace| edge_spans.contains(&(trace, parent)))
                    })))
            && (self.levels.is_empty()
                || entry
                    .level
                    .is_some_and(|level| self.levels.contains(&level)))
            && (self.kinds.is_empty() || self.kinds.contains(&entry.kind))
            && match self.status {
                None => true,
                Some(StatusFilter::Error) => entry.error,
                Some(StatusFilter::Ok) => !entry.error,
            }
            && self
                .text
                .as_ref()
                .is_none_or(|text| entry.search.contains(&text.to_lowercase()))
    }
}

/// One page of the log, newest first; `next_before` continues to older entries.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LogPage {
    pub entries: Vec<LogEntry>,
    pub next_before: Option<LogCursor>,
}

/// SQL on one line: runs of whitespace become one space.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A URL without its scheme; same-origin browser calls read like `localhost:5173/api/notes`.
fn short_url(url: &str) -> &str {
    url.split_once("://").map_or(url, |(_, rest)| rest)
}

fn cut(text: &str) -> String {
    match text.char_indices().nth(MAX_TEXT_CHARS) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    // Core
    use chepio_lens_conventions::keys::{DB_SYSTEM_NAME, SERVER_ADDRESS};

    use super::*;
    use crate::domain::linker::tests::span;
    use crate::domain::span::AttrValue;

    #[test]
    fn spans_become_lines_tagged_by_layer() {
        let mut fetch = span(
            "web",
            SpanKind::Client,
            1,
            None,
            &[
                (HTTP_REQUEST_METHOD, AttrValue::Str("POST".into())),
                (
                    URL_FULL,
                    AttrValue::Str("http://localhost:5173/api/notes".into()),
                ),
                (HTTP_RESPONSE_STATUS_CODE, AttrValue::Int(201)),
            ],
        );
        fetch.service.kind = ServiceKind::Frontend;
        let mut server = span("api", SpanKind::Server, 2, Some(1), &[]);
        server.name = "POST /api/notes".into();
        let query = span(
            "api",
            SpanKind::Client,
            3,
            Some(2),
            &[
                (DB_SYSTEM_NAME, AttrValue::Str("postgresql".into())),
                (SERVER_ADDRESS, AttrValue::Str("db".into())),
                (
                    DB_QUERY_TEXT,
                    AttrValue::Str("INSERT INTO notes (text)\n    VALUES ($1)".into()),
                ),
            ],
        );
        let call = span(
            "api",
            SpanKind::Client,
            4,
            Some(2),
            &[
                (HTTP_REQUEST_METHOD, AttrValue::Str("GET".into())),
                (
                    URL_FULL,
                    AttrValue::Str("https://payments.example.com/charge".into()),
                ),
            ],
        );

        let lines: Vec<_> = [&fetch, &server, &query, &call]
            .iter()
            .enumerate()
            .map(|(seq, span)| LogEntry::from_span(span, seq as u64))
            .map(|entry| (entry.layer, entry.kind, entry.text, entry.nodes))
            .collect();

        assert_eq!(
            lines,
            [
                (
                    Layer::Frontend,
                    LogKind::Request,
                    "POST localhost:5173/api/notes".into(),
                    vec!["svc:web".to_owned()]
                ),
                (
                    Layer::Backend,
                    LogKind::Request,
                    "POST /api/notes".into(),
                    vec!["svc:api".to_owned()]
                ),
                (
                    Layer::Database,
                    LogKind::Query,
                    "INSERT INTO notes (text) VALUES ($1)".into(),
                    vec!["svc:api".to_owned(), "db:postgresql:db".to_owned()]
                ),
                (
                    Layer::Backend,
                    LogKind::Call,
                    "GET payments.example.com/charge".into(),
                    vec!["svc:api".to_owned()]
                ),
            ]
        );
    }

    #[test]
    fn entries_keep_status_errors_and_searchable_text() {
        let failing = span(
            "api",
            SpanKind::Server,
            5,
            None,
            &[(HTTP_RESPONSE_STATUS_CODE, AttrValue::Int(500))],
        );

        let entry = LogEntry::from_span(&failing, 9);

        assert_eq!(
            (entry.status_code, entry.error, entry.seq),
            (Some(500), true, 9)
        );
        assert!(entry.search.contains("span 5 api 07070707"));
        let long = "x".repeat(MAX_TEXT_CHARS + 5);
        assert_eq!(cut(&long).chars().count(), MAX_TEXT_CHARS + 1);
    }

    #[test]
    fn queries_combine_layers_node_edge_status_and_text() {
        let mut server = LogEntry::from_span(&span("api", SpanKind::Server, 2, Some(1), &[]), 1);
        server.text = "POST /api/notes".into();
        server.search = "post /api/notes api".into();
        let mut failing = server.clone();
        failing.error = true;
        let edge_spans =
            std::collections::HashSet::from([(server.trace_id.unwrap(), SpanId([1; 8]))]);
        let query = |query: LogQuery| query.matches(&server, &edge_spans);

        assert!(query(LogQuery::default()));
        assert!(query(LogQuery {
            layers: vec![Layer::Frontend, Layer::Backend],
            ..LogQuery::default()
        }));
        assert!(!query(LogQuery {
            layers: vec![Layer::Database],
            ..LogQuery::default()
        }));
        assert!(query(LogQuery {
            node: Some("svc:api".into()),
            ..LogQuery::default()
        }));
        assert!(!query(LogQuery {
            node: Some("svc:web".into()),
            ..LogQuery::default()
        }));
        // The server span's parent is the hop's client span.
        assert!(query(LogQuery {
            edge: Some("svc:web->svc:api".into()),
            ..LogQuery::default()
        }));
        assert!(
            !LogQuery {
                edge: Some("svc:web->svc:api".into()),
                ..LogQuery::default()
            }
            .matches(&server, &std::collections::HashSet::new())
        );
        assert!(query(LogQuery {
            text: Some("API/NOTES".into()),
            ..LogQuery::default()
        }));
        assert!(!query(LogQuery {
            text: Some("login".into()),
            ..LogQuery::default()
        }));
        let errors = LogQuery {
            status: Some(StatusFilter::Error),
            ..LogQuery::default()
        };
        assert!(!errors.matches(&server, &edge_spans));
        assert!(errors.matches(&failing, &edge_spans));
    }
}
