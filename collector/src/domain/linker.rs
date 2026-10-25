//! Turns spans into calls between nodes (I6). Spans can arrive in any order: a client span waits for its server
//! child for the link window, and a server span waits for its client parent just as long (I7).

// Core
use std::collections::{HashMap, VecDeque};

use chepio_lens_conventions::keys::{
    DB_COLLECTION_NAME, DB_NAMESPACE, DB_OPERATION_NAME, DB_SYSTEM_NAME, HTTP_REQUEST_METHOD,
    HTTP_ROUTE, SERVER_ADDRESS, SERVER_PORT, URL_FULL,
};
// Domain
use super::node::{DbTarget, ExternalTarget};
use super::span::{Service, Span, SpanId, SpanKind, TraceId};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum LinkTarget {
    Service(Service),
    Database(DbTarget),
    External(ExternalTarget),
}

/// One call from a service to another node, derived only from span data.
#[derive(Debug, Clone, PartialEq)]
pub struct Link {
    pub trace_id: TraceId,
    /// The calling (client) span; places the hop on the request's timeline.
    pub client_span_id: SpanId,
    /// Start of the client span, used to order a request's edges.
    pub start_ns: u64,
    pub from: Service,
    pub to: LinkTarget,
    /// Duration as the caller saw it (the client span).
    pub duration_ns: u64,
    pub error: bool,
    /// The callee's route (`GET /api/notes`, `SELECT notes`), for the per-route breakdown of the edge.
    pub route: String,
}

#[derive(Debug, Clone, Copy)]
pub struct LinkerLimits {
    pub window_ms: u64,
    /// Client spans waiting for their server child; on overflow the oldest goes to its external node now.
    pub max_pending: usize,
    /// Server spans waiting for their client parent; on overflow the oldest is dropped.
    pub max_orphans: usize,
}

type Key = (TraceId, SpanId);

struct PendingClient {
    span_id: SpanId,
    /// Route of the call as the client sees it, used when the call ends at an external node.
    route: String,
    service: Service,
    start_ns: u64,
    duration_ns: u64,
    error: bool,
    target: ExternalTarget,
    deadline_ms: u64,
}

struct OrphanServer {
    service: Service,
    route: String,
    error: bool,
    deadline_ms: u64,
}

pub struct Linker {
    limits: LinkerLimits,
    pending: HashMap<Key, PendingClient>,
    /// Insertion order with deadlines; entries whose client was linked meanwhile are skipped.
    pending_order: VecDeque<(Key, u64)>,
    /// Keyed by the server's parent, which is the client span it waits for.
    orphans: HashMap<Key, OrphanServer>,
    orphan_order: VecDeque<(Key, u64)>,
    dropped_orphans: u64,
}

impl Linker {
    pub fn new(limits: LinkerLimits) -> Self {
        Self {
            limits,
            pending: HashMap::new(),
            pending_order: VecDeque::new(),
            orphans: HashMap::new(),
            orphan_order: VecDeque::new(),
            dropped_orphans: 0,
        }
    }

    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    pub fn dropped_orphans(&self) -> u64 {
        self.dropped_orphans
    }

    pub fn clear(&mut self) {
        *self = Self::new(self.limits);
    }

    pub fn on_span(&mut self, span: &Span, now_ms: u64) -> Vec<Link> {
        match span.kind {
            SpanKind::Client => self.on_client(span, now_ms),
            SpanKind::Server => self.on_server(span, now_ms),
            _ => Vec::new(),
        }
    }

    fn on_client(&mut self, span: &Span, now_ms: u64) -> Vec<Link> {
        if let Some(db) = db_target(span) {
            return vec![Link {
                route: db_route(span),
                trace_id: span.trace_id,
                client_span_id: span.span_id,
                start_ns: span.start_ns,
                from: span.service.clone(),
                to: LinkTarget::Database(db),
                duration_ns: span.duration_ns(),
                error: span.is_error(),
            }];
        }
        let key = (span.trace_id, span.span_id);
        if let Some(server) = self.orphans.remove(&key) {
            let client = PendingClient {
                span_id: span.span_id,
                route: client_route(span),
                service: span.service.clone(),
                start_ns: span.start_ns,
                duration_ns: span.duration_ns(),
                error: span.is_error(),
                target: ExternalTarget::default(),
                deadline_ms: 0,
            };
            return http_link(
                span.trace_id,
                client,
                server.service,
                server.error,
                server.route,
            )
            .into_iter()
            .collect();
        }
        let mut links = Vec::new();
        if self.pending.len() >= self.limits.max_pending {
            links.extend(self.evict_oldest_pending());
        }
        let deadline_ms = now_ms + self.limits.window_ms;
        self.pending.insert(
            key,
            PendingClient {
                span_id: span.span_id,
                route: client_route(span),
                service: span.service.clone(),
                start_ns: span.start_ns,
                duration_ns: span.duration_ns(),
                error: span.is_error(),
                target: external_target(span),
                deadline_ms,
            },
        );
        self.pending_order.push_back((key, deadline_ms));
        self.compact();
        links
    }

    fn on_server(&mut self, span: &Span, now_ms: u64) -> Vec<Link> {
        let Some(parent) = span.parent_span_id else {
            return Vec::new();
        };
        let key = (span.trace_id, parent);
        if let Some(client) = self.pending.remove(&key) {
            return http_link(
                span.trace_id,
                client,
                span.service.clone(),
                span.is_error(),
                server_route(span),
            )
            .into_iter()
            .collect();
        }
        if self.orphans.len() >= self.limits.max_orphans {
            self.evict_oldest_orphan();
        }
        let deadline_ms = now_ms + self.limits.window_ms;
        self.orphans.insert(
            key,
            OrphanServer {
                service: span.service.clone(),
                route: server_route(span),
                error: span.is_error(),
                deadline_ms,
            },
        );
        self.orphan_order.push_back((key, deadline_ms));
        self.compact();
        Vec::new()
    }

    /// Clients whose window has passed are counted on their external node; servers still waiting for a parent are
    /// dropped. A server that arrives after its client expired adds nothing: that call already counts as external.
    pub fn expire(&mut self, now_ms: u64) -> Vec<Link> {
        let mut links = Vec::new();
        while let Some(&(key, deadline)) = self.pending_order.front() {
            if deadline > now_ms {
                break;
            }
            self.pending_order.pop_front();
            if self
                .pending
                .get(&key)
                .is_some_and(|client| client.deadline_ms == deadline)
            {
                let client = self.pending.remove(&key).expect("checked above");
                links.push(external_link(key.0, client));
            }
        }
        while let Some(&(key, deadline)) = self.orphan_order.front() {
            if deadline > now_ms {
                break;
            }
            self.orphan_order.pop_front();
            if self
                .orphans
                .get(&key)
                .is_some_and(|server| server.deadline_ms == deadline)
            {
                self.orphans.remove(&key);
            }
        }
        links
    }

    fn evict_oldest_pending(&mut self) -> Option<Link> {
        while let Some((key, deadline)) = self.pending_order.pop_front() {
            if self
                .pending
                .get(&key)
                .is_some_and(|client| client.deadline_ms == deadline)
            {
                let client = self.pending.remove(&key).expect("checked above");
                return Some(external_link(key.0, client));
            }
        }
        None
    }

    fn evict_oldest_orphan(&mut self) {
        while let Some((key, deadline)) = self.orphan_order.pop_front() {
            if self
                .orphans
                .get(&key)
                .is_some_and(|server| server.deadline_ms == deadline)
            {
                self.orphans.remove(&key);
                self.dropped_orphans += 1;
                return;
            }
        }
    }

    /// Keeps the order queues bounded (I9) when many entries were linked before their deadline.
    fn compact(&mut self) {
        if self.pending_order.len() > 2 * self.limits.max_pending.max(1) {
            let pending = &self.pending;
            self.pending_order.retain(|(key, deadline)| {
                pending.get(key).is_some_and(|c| c.deadline_ms == *deadline)
            });
        }
        if self.orphan_order.len() > 2 * self.limits.max_orphans.max(1) {
            let orphans = &self.orphans;
            self.orphan_order.retain(|(key, deadline)| {
                orphans.get(key).is_some_and(|s| s.deadline_ms == *deadline)
            });
        }
    }
}

/// No link for a call inside one service.
fn http_link(
    trace_id: TraceId,
    client: PendingClient,
    server: Service,
    server_error: bool,
    route: String,
) -> Option<Link> {
    (client.service.name != server.name).then_some(Link {
        route,
        trace_id,
        client_span_id: client.span_id,
        start_ns: client.start_ns,
        from: client.service,
        to: LinkTarget::Service(server),
        duration_ns: client.duration_ns,
        error: client.error || server_error,
    })
}

fn external_link(trace_id: TraceId, client: PendingClient) -> Link {
    Link {
        route: client.route.clone(),
        trace_id,
        client_span_id: client.span_id,
        start_ns: client.start_ns,
        from: client.service,
        to: LinkTarget::External(client.target),
        duration_ns: client.duration_ns,
        error: client.error,
    }
}

fn port(span: &Span) -> Option<u16> {
    span.attr_i64(SERVER_PORT)
        .and_then(|port| u16::try_from(port).ok())
}

/// `<method> <route>` of a server span, else its name.
fn server_route(span: &Span) -> String {
    match (
        span.attr_str(HTTP_REQUEST_METHOD),
        span.attr_str(HTTP_ROUTE),
    ) {
        (Some(method), Some(route)) => format!("{method} {route}"),
        _ => span.name.clone(),
    }
}

/// `<method> <path>` of a client call, else its name.
fn client_route(span: &Span) -> String {
    let path = span.attr_str(URL_FULL).and_then(|url| {
        let (_, rest) = url.split_once("://")?;
        let path = &rest[rest.find('/')?..];
        Some(path.split(['?', '#']).next().unwrap_or(path))
    });
    match (span.attr_str(HTTP_REQUEST_METHOD), path) {
        (Some(method), Some(path)) => format!("{method} {path}"),
        _ => span.name.clone(),
    }
}

/// `<operation> <collection>` of a query, else its name.
fn db_route(span: &Span) -> String {
    match (
        span.attr_str(DB_OPERATION_NAME),
        span.attr_str(DB_COLLECTION_NAME),
    ) {
        (Some(operation), Some(collection)) => format!("{operation} {collection}"),
        (Some(operation), None) => operation.to_owned(),
        _ => span.name.clone(),
    }
}

pub(crate) fn db_target(span: &Span) -> Option<DbTarget> {
    let system = span.attr_str(DB_SYSTEM_NAME)?;
    Some(DbTarget {
        system: system.to_owned(),
        address: span.attr_str(SERVER_ADDRESS).map(str::to_owned),
        port: port(span),
        namespace: span.attr_str(DB_NAMESPACE).map(str::to_owned),
    })
}

fn external_target(span: &Span) -> ExternalTarget {
    match span.attr_str(SERVER_ADDRESS) {
        Some(address) => ExternalTarget {
            address: Some(address.to_owned()),
            port: port(span),
        },
        None => span
            .attr_str(URL_FULL)
            .map(host_and_port)
            .unwrap_or_default(),
    }
}

/// Host and port of an absolute URL; the port defaults by scheme (80 for http, 443 for https).
fn host_and_port(url: &str) -> ExternalTarget {
    let Some((scheme, rest)) = url.split_once("://") else {
        return ExternalTarget::default();
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host_port = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let (host, port) = match host_port.rsplit_once(':') {
        Some((host, port)) if !port.contains(']') => (host, port.parse().ok()),
        _ => (host_port, None),
    };
    let port = port.or(match scheme {
        "http" => Some(80),
        "https" => Some(443),
        _ => None,
    });
    ExternalTarget {
        address: (!host.is_empty()).then(|| host.to_owned()),
        port,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    // Core
    use super::*;
    use crate::domain::span::{AttrValue, Attributes, ServiceKind, Status};

    pub(crate) const LIMITS: LinkerLimits = LinkerLimits {
        window_ms: 10_000,
        max_pending: 100,
        max_orphans: 100,
    };

    pub(crate) fn span(
        service: &str,
        kind: SpanKind,
        id: u8,
        parent: Option<u8>,
        attributes: &[(&str, AttrValue)],
    ) -> Span {
        Span {
            trace_id: TraceId([7; 16]),
            span_id: SpanId([id; 8]),
            parent_span_id: parent.map(|parent| SpanId([parent; 8])),
            service: Service {
                name: service.into(),
                kind: ServiceKind::Service,
            },
            kind,
            name: format!("span {id}"),
            start_ns: u64::from(id) * 1_000,
            end_ns: u64::from(id) * 1_000 + 500_000,
            status: Status::Unset,
            attributes: attributes
                .iter()
                .map(|(key, value)| ((*key).to_owned(), value.clone()))
                .collect::<Attributes>(),
            truncated_attributes: Vec::new(),
            events: Vec::new(),
        }
    }

    fn target_service(link: &Link) -> &str {
        match &link.to {
            LinkTarget::Service(service) => &service.name,
            other => panic!("expected a service target, got {other:?}"),
        }
    }

    #[test]
    fn client_then_server_links_on_server_arrival() {
        let mut linker = Linker::new(LIMITS);
        assert!(
            linker
                .on_span(&span("web", SpanKind::Client, 1, None, &[]), 0)
                .is_empty()
        );
        let links = linker.on_span(&span("api", SpanKind::Server, 2, Some(1), &[]), 5);
        assert_eq!(links.len(), 1);
        assert_eq!(
            (links[0].from.name.as_str(), target_service(&links[0])),
            ("web", "api")
        );
        assert_eq!(
            links[0].duration_ns, 500_000,
            "the caller's duration counts"
        );
        assert_eq!(linker.pending_count(), 0);
    }

    #[test]
    fn server_then_client_links_on_client_arrival() {
        let mut linker = Linker::new(LIMITS);
        assert!(
            linker
                .on_span(&span("api", SpanKind::Server, 2, Some(1), &[]), 0)
                .is_empty()
        );
        let links = linker.on_span(&span("web", SpanKind::Client, 1, None, &[]), 5);
        assert_eq!(
            (links[0].from.name.as_str(), target_service(&links[0])),
            ("web", "api")
        );
        assert!(
            linker.expire(1_000_000).is_empty(),
            "nothing left to expire"
        );
    }

    #[test]
    fn database_client_links_at_once() {
        let mut linker = Linker::new(LIMITS);
        let db = span(
            "api",
            SpanKind::Client,
            3,
            Some(2),
            &[
                (DB_SYSTEM_NAME, AttrValue::Str("postgresql".into())),
                (SERVER_ADDRESS, AttrValue::Str("db".into())),
                (SERVER_PORT, AttrValue::Int(5432)),
                (DB_NAMESPACE, AttrValue::Str("demo".into())),
            ],
        );
        let links = linker.on_span(&db, 0);
        let LinkTarget::Database(target) = &links[0].to else {
            panic!("expected a database target");
        };
        assert_eq!(target.node_id(), "db:postgresql:db:5432/demo");
        assert_eq!(linker.pending_count(), 0);
    }

    #[test]
    fn unanswered_client_goes_to_its_external_node_after_the_window() {
        let mut linker = Linker::new(LIMITS);
        let client = span(
            "api",
            SpanKind::Client,
            4,
            Some(2),
            &[(
                URL_FULL,
                AttrValue::Str("https://payments.example.com/charge?id=1".into()),
            )],
        );
        linker.on_span(&client, 1_000);
        assert!(linker.expire(10_999).is_empty(), "still inside the window");
        let links = linker.expire(11_000);
        let LinkTarget::External(target) = &links[0].to else {
            panic!("expected an external target");
        };
        assert_eq!(target.node_id(), "ext:payments.example.com:443");
    }

    #[test]
    fn server_after_expiry_does_not_count_again() {
        let mut linker = Linker::new(LIMITS);
        linker.on_span(&span("web", SpanKind::Client, 1, None, &[]), 0);
        assert_eq!(linker.expire(10_000).len(), 1);
        assert!(
            linker
                .on_span(&span("api", SpanKind::Server, 2, Some(1), &[]), 10_001)
                .is_empty()
        );
        assert!(linker.expire(30_000).is_empty());
    }

    #[test]
    fn calls_inside_one_service_make_no_link() {
        let mut linker = Linker::new(LIMITS);
        linker.on_span(&span("api", SpanKind::Client, 1, None, &[]), 0);
        assert!(
            linker
                .on_span(&span("api", SpanKind::Server, 2, Some(1), &[]), 1)
                .is_empty()
        );
    }

    #[test]
    fn pending_overflow_sends_the_oldest_client_to_its_external_node_now() {
        let mut linker = Linker::new(LinkerLimits {
            max_pending: 2,
            ..LIMITS
        });
        let client = |id| {
            span(
                "api",
                SpanKind::Client,
                id,
                None,
                &[(SERVER_ADDRESS, AttrValue::Str(format!("h{id}")))],
            )
        };
        assert!(linker.on_span(&client(1), 0).is_empty());
        assert!(linker.on_span(&client(2), 0).is_empty());
        let links = linker.on_span(&client(3), 0);
        assert_eq!(links.len(), 1);
        assert_eq!(
            links[0].to,
            LinkTarget::External(ExternalTarget {
                address: Some("h1".into()),
                port: None
            })
        );
        assert_eq!(linker.pending_count(), 2);
    }

    #[test]
    fn orphan_overflow_drops_the_oldest_server() {
        let mut linker = Linker::new(LinkerLimits {
            max_orphans: 1,
            ..LIMITS
        });
        linker.on_span(&span("api", SpanKind::Server, 2, Some(1), &[]), 0);
        linker.on_span(&span("api", SpanKind::Server, 4, Some(3), &[]), 0);
        assert_eq!(linker.dropped_orphans(), 1);
        assert!(
            linker
                .on_span(&span("web", SpanKind::Client, 1, None, &[]), 1)
                .is_empty(),
            "its server was dropped"
        );
        assert_eq!(
            linker
                .on_span(&span("web", SpanKind::Client, 3, None, &[]), 1)
                .len(),
            1
        );
    }

    #[test]
    fn order_queues_stay_bounded_when_clients_link_quickly() {
        let mut linker = Linker::new(LinkerLimits {
            max_pending: 4,
            ..LIMITS
        });
        for id in 1..=100u8 {
            linker.on_span(&span("web", SpanKind::Client, id, None, &[]), 0);
            linker.on_span(
                &span("api", SpanKind::Server, id.wrapping_add(100), Some(id), &[]),
                0,
            );
        }
        assert!(linker.pending_order.len() <= 8);
        assert_eq!(linker.pending_count(), 0);
    }

    #[test]
    fn host_and_port_parses_urls() {
        let target = |url| {
            let t = host_and_port(url);
            (t.address, t.port)
        };
        assert_eq!(
            target("http://api:8080/x"),
            (Some("api".into()), Some(8080))
        );
        assert_eq!(
            target("http://user:pw@api/x"),
            (Some("api".into()), Some(80))
        );
        assert_eq!(
            target("https://[::1]:8443/"),
            (Some("[::1]".into()), Some(8443))
        );
        assert_eq!(target("not a url"), (None, None));
    }
}
