// Core
use std::collections::BTreeSet;

use chepio_lens_conventions::keys::{
    HTTP_REQUEST_METHOD, HTTP_RESPONSE_STATUS_CODE, HTTP_ROUTE, URL_FULL, URL_PATH,
};
// Domain
use super::span::{Span, TraceId};

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
    /// Edge ids the request touched, ordered by the start of the calling span; used for animation.
    pub edges: Vec<String>,
}

impl RequestSummary {
    /// `spans` must not be empty. The root is the earliest span without a parent, else the earliest span.
    pub fn from_spans(
        trace_id: TraceId,
        spans: &[Span],
        edges: &[(u64, String)],
        dropped_spans: u64,
    ) -> Self {
        let order = |span: &&Span| (span.start_ns, span.span_id);
        let root = spans
            .iter()
            .filter(|span| span.parent_span_id.is_none())
            .min_by_key(order)
            .or_else(|| spans.iter().min_by_key(order))
            .expect("a request has at least one span");
        let start_ns = spans.iter().map(|span| span.start_ns).min().unwrap_or(0);
        let end_ns = spans.iter().map(|span| span.end_ns).max().unwrap_or(0);
        let mut ordered_edges = edges.to_vec();
        ordered_edges.sort();
        Self {
            trace_id,
            name: root.name.clone(),
            service: root.service.name.clone(),
            method: root.attr_str(HTTP_REQUEST_METHOD).map(str::to_owned),
            route: root
                .attr_str(HTTP_ROUTE)
                .or_else(|| root.attr_str(URL_PATH))
                .or_else(|| root.attr_str(URL_FULL).and_then(url_path))
                .map(str::to_owned),
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
            edges: ordered_edges.into_iter().map(|(_, id)| id).collect(),
        }
    }
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
    use crate::domain::span::{AttrValue, SpanKind};

    #[test]
    fn summary_uses_the_root_span_and_orders_edges() {
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
        let edges = [
            (3_000, "svc:api->db:x".to_owned()),
            (1_000, "svc:web->svc:api".to_owned()),
        ];

        let summary = RequestSummary::from_spans(root.trace_id, &[child, root], &edges, 2);

        assert_eq!(summary.name, "span 2");
        assert_eq!(summary.method.as_deref(), Some("GET"));
        assert_eq!(summary.route.as_deref(), Some("/api/notes"));
        assert_eq!(summary.status_code, Some(500));
        assert!(summary.error);
        assert_eq!(summary.span_count, 2);
        assert_eq!(summary.dropped_spans, 2);
        assert_eq!(summary.start_ns, 2_000);
        assert_eq!(summary.duration_ns, 501_000);
        assert_eq!(summary.edges, ["svc:web->svc:api", "svc:api->db:x"]);
    }

    #[test]
    fn route_falls_back_to_the_path_of_url_full() {
        let browser = span(
            "web",
            SpanKind::Client,
            1,
            None,
            &[(
                URL_FULL,
                AttrValue::Str("http://localhost:5173/api/notes?limit=5#top".into()),
            )],
        );
        let summary = RequestSummary::from_spans(browser.trace_id, &[browser], &[], 0);
        assert_eq!(summary.route.as_deref(), Some("/api/notes"));
        assert_eq!(url_path("http://host"), None);
    }
}
