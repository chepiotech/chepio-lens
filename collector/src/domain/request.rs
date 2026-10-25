// Core
use std::collections::{BTreeSet, HashMap};

use chepio_lens_conventions::keys::{
    HTTP_REQUEST_METHOD, HTTP_RESPONSE_STATUS_CODE, HTTP_ROUTE, URL_FULL, URL_PATH,
};
// Domain
use super::packet::Packet;
use super::span::{Span, SpanId, SpanKind, TraceId};

/// How far up the span tree a hop looks for the hop that called it; bounds the walk on malformed traces.
const MAX_PARENT_DEPTH: usize = 64;

/// One edge a request touched, as recorded at linking time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HopRecord {
    pub edge_id: String,
    /// The calling (client) span.
    pub client_span_id: SpanId,
    pub start_ns: u64,
    pub duration_ns: u64,
}

/// A hop placed on the request's timeline; used for animation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hop {
    pub edge: String,
    pub start_offset_ns: u64,
    pub duration_ns: u64,
    /// What travelled; `None` when the caller span is no longer stored.
    pub packet: Option<Packet>,
}

/// A request with all its spans, for the inspector.
#[derive(Debug, Clone, PartialEq)]
pub struct RequestDetail {
    pub summary: RequestSummary,
    /// Ordered by start time as received (I12: offsets across processes are not corrected).
    pub spans: Vec<Span>,
}

/// Summary of one trace, rebuilt as its spans arrive.
#[derive(Debug, Clone, PartialEq)]
pub struct RequestSummary {
    pub trace_id: TraceId,
    pub name: String,
    pub service: String,
    pub method: Option<String>,
    pub route: Option<String>,
    pub status_code: Option<u16>,
    pub start_ns: u64,
    pub duration_ns: u64,
    pub services: Vec<String>,
    pub error: bool,
    pub span_count: usize,
    pub dropped_spans: u64,
    /// A span without a parent has arrived, so the request's entry point is known. Spans of one request come from
    /// several processes in separate batches; the UI waits for the root before it animates the request.
    pub has_root: bool,
    /// Hops ordered by their offset on the request's timeline.
    pub hops: Vec<Hop>,
}

impl RequestSummary {
    /// `spans` must not be empty. The root is the earliest span without a parent, else the earliest span.
    pub fn from_spans(
        trace_id: TraceId,
        spans: &[Span],
        hops: &[HopRecord],
        dropped_spans: u64,
    ) -> Self {
        let order = |span: &&Span| (span.start_ns, span.span_id);
        let entry = spans
            .iter()
            .filter(|span| span.parent_span_id.is_none())
            .min_by_key(order);
        let root = entry
            .or_else(|| spans.iter().min_by_key(order))
            .expect("a request has at least one span");
        let start_ns = spans.iter().map(|span| span.start_ns).min().unwrap_or(0);
        let end_ns = spans.iter().map(|span| span.end_ns).max().unwrap_or(0);
        let method = root.attr_str(HTTP_REQUEST_METHOD).map(str::to_owned);
        let route = root
            .attr_str(HTTP_ROUTE)
            .or_else(|| root.attr_str(URL_PATH))
            .or_else(|| root.attr_str(URL_FULL).and_then(url_path))
            .map(str::to_owned);
        // Browser fetch spans are named by the method alone; the route makes them as readable as server spans.
        let name = match (&method, &route) {
            (Some(method), Some(route)) if root.name == *method => format!("{method} {route}"),
            _ => root.name.clone(),
        };
        Self {
            trace_id,
            name,
            service: root.service.name.clone(),
            method,
            route,
            status_code: root
                .attr_i64(HTTP_RESPONSE_STATUS_CODE)
                .and_then(|code| u16::try_from(code).ok()),
            start_ns,
            duration_ns: end_ns.saturating_sub(start_ns),
            services: spans
                .iter()
                .map(|span| span.service.name.clone())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect(),
            error: spans.iter().any(Span::is_error),
            span_count: spans.len(),
            dropped_spans,
            has_root: entry.is_some(),
            hops: place_hops(spans, hops),
        }
    }
}

/// Places hops on one timeline without comparing clocks of different processes (I12). A hop called from inside
/// another hop's server span starts at that hop's offset, plus half the time the caller saw beyond the server span
/// (network), plus how far into the server span the call started (one clock). Hops without a traced calling hop are
/// placed by their own start, relative to the earliest of them.
fn place_hops(spans: &[Span], records: &[HopRecord]) -> Vec<Hop> {
    let by_id: HashMap<SpanId, &Span> = spans.iter().map(|span| (span.span_id, span)).collect();
    let by_client: HashMap<SpanId, usize> = records
        .iter()
        .enumerate()
        .map(|(index, record)| (record.client_span_id, index))
        .collect();
    // For each hop: the hop that called it and the callee's span directly under that hop's client span.
    let parents: Vec<Option<(usize, Option<&Span>)>> = records
        .iter()
        .map(|record| calling_hop(record.client_span_id, &by_id, &by_client))
        .collect();
    let root_start = records
        .iter()
        .zip(&parents)
        .filter(|(_, parent)| parent.is_none())
        .map(|(record, _)| record.start_ns)
        .min()
        .unwrap_or(0);

    let mut offsets: Vec<Option<u64>> = vec![None; records.len()];
    for index in 0..records.len() {
        offset_of(
            index,
            records,
            &parents,
            &by_id,
            root_start,
            &mut offsets,
            0,
        );
    }
    let mut hops: Vec<Hop> = records
        .iter()
        .zip(offsets)
        .map(|(record, offset)| Hop {
            edge: record.edge_id.clone(),
            start_offset_ns: offset.unwrap_or(0),
            duration_ns: record.duration_ns,
            packet: by_id.get(&record.client_span_id).map(|caller| {
                let callee = spans.iter().find(|span| {
                    span.kind == SpanKind::Server
                        && span.parent_span_id == Some(record.client_span_id)
                });
                Packet::of(caller, callee)
            }),
        })
        .collect();
    hops.sort_by(|a, b| (a.start_offset_ns, &a.edge).cmp(&(b.start_offset_ns, &b.edge)));
    hops
}

/// Walks up from a hop's client span to the nearest ancestor that is another hop's client span.
fn calling_hop<'a>(
    client: SpanId,
    by_id: &HashMap<SpanId, &'a Span>,
    by_client: &HashMap<SpanId, usize>,
) -> Option<(usize, Option<&'a Span>)> {
    let mut below = None;
    let mut current = by_id.get(&client)?.parent_span_id?;
    for _ in 0..MAX_PARENT_DEPTH {
        if let Some(&index) = by_client.get(&current) {
            return Some((index, below));
        }
        let span = by_id.get(&current)?;
        below = Some(*span);
        current = span.parent_span_id?;
    }
    None
}

fn offset_of(
    index: usize,
    records: &[HopRecord],
    parents: &[Option<(usize, Option<&Span>)>],
    by_id: &HashMap<SpanId, &Span>,
    root_start: u64,
    offsets: &mut [Option<u64>],
    depth: usize,
) -> u64 {
    if let Some(offset) = offsets[index] {
        return offset;
    }
    let record = &records[index];
    let offset = match parents[index] {
        Some((parent, callee)) if depth < MAX_PARENT_DEPTH && parent != index => {
            let parent_offset = offset_of(
                parent,
                records,
                parents,
                by_id,
                root_start,
                offsets,
                depth + 1,
            );
            let (network, into_callee) = match (callee, by_id.get(&record.client_span_id)) {
                (Some(callee), Some(client)) => (
                    records[parent]
                        .duration_ns
                        .saturating_sub(callee.duration_ns())
                        / 2,
                    client.start_ns.saturating_sub(callee.start_ns),
                ),
                _ => (0, 0),
            };
            parent_offset + network + into_callee
        }
        _ => record.start_ns.saturating_sub(root_start),
    };
    offsets[index] = Some(offset);
    offset
}

/// Path of an absolute URL (browser client spans carry only `url.full`).
fn url_path(url: &str) -> Option<&str> {
    let (_, rest) = url.split_once("://")?;
    let path = &rest[rest.find('/')?..];
    Some(path.split(['?', '#']).next().unwrap_or(path))
}

#[cfg(test)]
mod tests {
    // Core
    use super::*;
    use crate::domain::linker::tests::span;
    use crate::domain::packet::{BodyKind, PacketKind};
    use crate::domain::span::{AttrValue, SpanKind};
    use chepio_lens_conventions::keys::{DB_OPERATION_NAME, DB_SYSTEM_NAME};

    fn hop(edge: &str, client: u8, start_ns: u64, duration_ns: u64) -> HopRecord {
        HopRecord {
            edge_id: edge.into(),
            client_span_id: SpanId([client; 8]),
            start_ns,
            duration_ns,
        }
    }

    fn timed(mut span: Span, start_ns: u64, duration_ns: u64) -> Span {
        span.start_ns = start_ns;
        span.end_ns = start_ns + duration_ns;
        span
    }

    #[test]
    fn summary_uses_the_root_span() {
        let root = span(
            "api",
            SpanKind::Server,
            2,
            None,
            &[
                (HTTP_REQUEST_METHOD, AttrValue::Str("GET".into())),
                (HTTP_ROUTE, AttrValue::Str("/api/notes".into())),
                (HTTP_RESPONSE_STATUS_CODE, AttrValue::Int(500)),
            ],
        );
        let child = span("api", SpanKind::Client, 3, Some(2), &[]);

        let trace_id = root.trace_id;
        let partial = RequestSummary::from_spans(trace_id, std::slice::from_ref(&child), &[], 0);
        let summary = RequestSummary::from_spans(trace_id, &[child, root], &[], 2);

        assert_eq!(summary.name, "span 2");
        assert_eq!(summary.method.as_deref(), Some("GET"));
        assert_eq!(summary.route.as_deref(), Some("/api/notes"));
        assert_eq!(summary.status_code, Some(500));
        assert!(summary.error);
        assert_eq!(summary.span_count, 2);
        assert_eq!(summary.dropped_spans, 2);
        assert_eq!(summary.start_ns, 2_000);
        assert_eq!(summary.duration_ns, 501_000);
        assert!(summary.has_root);
        assert!(
            !partial.has_root,
            "the server span that calls it has not arrived"
        );
    }

    #[test]
    fn route_falls_back_to_the_path_of_url_full_and_names_method_only_spans() {
        let mut browser = span(
            "web",
            SpanKind::Client,
            1,
            None,
            &[
                (HTTP_REQUEST_METHOD, AttrValue::Str("GET".into())),
                (
                    URL_FULL,
                    AttrValue::Str("http://localhost:5173/api/notes?limit=5#top".into()),
                ),
            ],
        );
        browser.name = "GET".into();
        let summary = RequestSummary::from_spans(browser.trace_id, &[browser], &[], 0);
        assert_eq!(summary.route.as_deref(), Some("/api/notes"));
        assert_eq!(summary.name, "GET /api/notes");
        assert_eq!(url_path("http://host"), None);
    }

    /// Browser fetch (span 1) → API server (2) → database query (3). The browser clock runs 5 s ahead of the API's,
    /// so comparing raw starts would put the query long before the fetch.
    #[test]
    fn hops_follow_the_call_tree_whatever_the_clock_skew() {
        const SKEW: u64 = 5_000_000_000;
        let fetch = timed(
            span(
                "web",
                SpanKind::Client,
                1,
                None,
                &[(URL_FULL, AttrValue::Str("http://web/api/notes".into()))],
            ),
            SKEW + 1_000,
            10_000,
        );
        // The server span fills in what the browser span lacks.
        let server = timed(
            span(
                "api",
                SpanKind::Server,
                2,
                Some(1),
                &[
                    (HTTP_REQUEST_METHOD, AttrValue::Str("GET".into())),
                    (HTTP_RESPONSE_STATUS_CODE, AttrValue::Int(200)),
                ],
            ),
            2_000,
            8_000,
        );
        let query = timed(
            span(
                "api",
                SpanKind::Client,
                3,
                Some(2),
                &[
                    (DB_SYSTEM_NAME, AttrValue::Str("postgresql".into())),
                    (DB_OPERATION_NAME, AttrValue::Str("SELECT".into())),
                ],
            ),
            5_000,
            3_000,
        );
        let records = [
            hop("svc:api->db:x", 3, 5_000, 3_000),
            hop("svc:web->svc:api", 1, SKEW + 1_000, 10_000),
        ];

        let summary =
            RequestSummary::from_spans(fetch.trace_id, &[query, server, fetch], &records, 0);

        assert_eq!(
            summary.hops,
            [
                Hop {
                    edge: "svc:web->svc:api".into(),
                    start_offset_ns: 0,
                    duration_ns: 10_000,
                    packet: Some(Packet {
                        kind: PacketKind::Http,
                        operation: Some("GET".into()),
                        request_body: BodyKind::None,
                        response_body: BodyKind::None,
                        status_code: Some(200),
                        error: false,
                    }),
                },
                // Half of the 2 µs the fetch saw beyond the server span, plus 3 µs into the server span.
                Hop {
                    edge: "svc:api->db:x".into(),
                    start_offset_ns: 1_000 + 3_000,
                    duration_ns: 3_000,
                    packet: Some(Packet {
                        kind: PacketKind::Sql,
                        operation: Some("SELECT".into()),
                        request_body: BodyKind::None,
                        response_body: BodyKind::None,
                        status_code: None,
                        error: false,
                    }),
                },
            ]
        );
    }

    #[test]
    fn hops_without_a_traced_caller_are_placed_by_their_own_start() {
        let server = timed(span("api", SpanKind::Server, 2, None, &[]), 1_000, 9_000);
        let first = timed(span("api", SpanKind::Client, 3, Some(2), &[]), 2_000, 1_000);
        let second = timed(span("api", SpanKind::Client, 4, Some(2), &[]), 4_000, 1_000);
        let records = [
            hop("svc:api->ext:b", 4, 4_000, 1_000),
            hop("svc:api->db:x", 3, 2_000, 1_000),
        ];

        let summary =
            RequestSummary::from_spans(server.trace_id, &[server, first, second], &records, 0);

        let placed: Vec<(&str, u64)> = summary
            .hops
            .iter()
            .map(|hop| (hop.edge.as_str(), hop.start_offset_ns))
            .collect();
        assert_eq!(placed, [("svc:api->db:x", 0), ("svc:api->ext:b", 2_000)]);
    }

    #[test]
    fn missing_spans_fall_back_to_recorded_starts() {
        // Only the hop records are known; the spans of the calling hop have not arrived yet.
        let query = timed(span("api", SpanKind::Client, 3, Some(2), &[]), 5_000, 3_000);
        let records = [hop("svc:api->db:x", 3, 5_000, 3_000)];

        let summary = RequestSummary::from_spans(query.trace_id, &[query], &records, 0);

        assert_eq!(summary.hops[0].start_offset_ns, 0);
    }
}
