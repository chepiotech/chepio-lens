// Core
use std::collections::{BTreeMap, BTreeSet};

// Domain
use super::edge::{Edge, EdgeKey, EdgeSnapshot, Protocol};
use super::linker::{Link, LinkTarget};
use super::node::{DbTarget, ExternalTarget, Node, NodeKind, service_node_id};
use super::span::{Service, ServiceKind};
use super::time::Now;

#[derive(Debug, Clone, Copy)]
pub struct GraphLimits {
    pub max_nodes: usize,
    pub max_edges: usize,
}

/// Nodes created and edges updated by one ingest, for SSE events.
#[derive(Debug, Default)]
pub struct Changes {
    pub nodes: BTreeSet<String>,
    pub edges: BTreeSet<EdgeKey>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GraphCounts {
    pub nodes: usize,
    pub edges: usize,
    pub dropped_nodes: u64,
    pub dropped_edges: u64,
}

/// The live map: kept for the collector's lifetime, independent of request eviction, bounded by node and edge count.
/// Over the bound new nodes and edges are ignored and counted (I9).
pub struct Graph {
    limits: GraphLimits,
    nodes: BTreeMap<String, Node>,
    edges: BTreeMap<EdgeKey, Edge>,
    dropped_nodes: u64,
    dropped_edges: u64,
}

impl Graph {
    pub fn new(limits: GraphLimits) -> Self {
        Self {
            limits,
            nodes: BTreeMap::new(),
            edges: BTreeMap::new(),
            dropped_nodes: 0,
            dropped_edges: 0,
        }
    }

    /// Creates the service's node on its first span; later spans only move `last_seen`.
    pub fn observe_service(&mut self, service: &Service, now: Now, changes: &mut Changes) -> bool {
        self.ensure_node(service_node(service, now), changes)
    }

    /// Counts one call on its edge, creating both nodes and the edge as needed. `None` when a bound kept it out.
    pub fn record(&mut self, link: &Link, now: Now, changes: &mut Changes) -> Option<EdgeKey> {
        let from = service_node(&link.from, now);
        let (to, protocol) = match &link.to {
            LinkTarget::Service(service) => (service_node(service, now), Protocol::Http),
            LinkTarget::Database(db) => (db_node(db, now), Protocol::Db),
            LinkTarget::External(external) => (external_node(external, now), Protocol::Http),
        };
        let key = EdgeKey {
            from: from.id.clone(),
            to: to.id.clone(),
            protocol,
        };
        if !self.ensure_node(from, changes) || !self.ensure_node(to, changes) {
            return None;
        }
        if !self.edges.contains_key(&key) && self.edges.len() >= self.limits.max_edges {
            self.dropped_edges += 1;
            return None;
        }
        self.edges
            .entry(key.clone())
            .or_insert_with(|| Edge::new(key.clone(), now.unix_ns))
            .record(link.duration_ns, link.error, now.mono_ms, now.unix_ns);
        changes.edges.insert(key.clone());
        Some(key)
    }

    fn ensure_node(&mut self, node: Node, changes: &mut Changes) -> bool {
        if let Some(existing) = self.nodes.get_mut(&node.id) {
            existing.last_seen_ns = node.last_seen_ns;
            return true;
        }
        if self.nodes.len() >= self.limits.max_nodes {
            self.dropped_nodes += 1;
            return false;
        }
        changes.nodes.insert(node.id.clone());
        self.nodes.insert(node.id.clone(), node);
        true
    }

    pub fn node(&self, id: &str) -> Option<&Node> {
        self.nodes.get(id)
    }

    pub fn edge_snapshot(&self, key: &EdgeKey, now_mono_ms: u64) -> Option<EdgeSnapshot> {
        self.edges.get(key).map(|edge| edge.snapshot(now_mono_ms))
    }

    pub fn snapshot(&self, now_mono_ms: u64) -> (Vec<Node>, Vec<EdgeSnapshot>) {
        let nodes = self.nodes.values().cloned().collect();
        let edges = self
            .edges
            .values()
            .map(|edge| edge.snapshot(now_mono_ms))
            .collect();
        (nodes, edges)
    }

    pub fn counts(&self) -> GraphCounts {
        GraphCounts {
            nodes: self.nodes.len(),
            edges: self.edges.len(),
            dropped_nodes: self.dropped_nodes,
            dropped_edges: self.dropped_edges,
        }
    }

    pub fn clear(&mut self) {
        *self = Self::new(self.limits);
    }
}

fn node(id: String, kind: NodeKind, label: String, now: Now) -> Node {
    Node {
        id,
        kind,
        label,
        db: None,
        external: None,
        first_seen_ns: now.unix_ns,
        last_seen_ns: now.unix_ns,
    }
}

fn service_node(service: &Service, now: Now) -> Node {
    let kind = match service.kind {
        ServiceKind::Frontend => NodeKind::Frontend,
        ServiceKind::Service => NodeKind::Service,
    };
    node(
        service_node_id(&service.name),
        kind,
        service.name.clone(),
        now,
    )
}

fn db_node(db: &DbTarget, now: Now) -> Node {
    Node {
        db: Some(db.clone()),
        ..node(db.node_id(), NodeKind::Database, db.label(), now)
    }
}

fn external_node(external: &ExternalTarget, now: Now) -> Node {
    Node {
        external: Some(external.clone()),
        ..node(
            external.node_id(),
            NodeKind::External,
            external.label(),
            now,
        )
    }
}

#[cfg(test)]
mod tests {
    // Core
    use chepio_lens_conventions::keys::{DB_SYSTEM_NAME, SERVER_ADDRESS};

    use super::*;
    use crate::domain::linker::Linker;
    use crate::domain::linker::tests::{LIMITS, span};
    use crate::domain::span::{AttrValue, Span, SpanKind};

    const NOW: Now = Now {
        mono_ms: 0,
        unix_ns: 1,
    };
    const ROOMY: GraphLimits = GraphLimits {
        max_nodes: 100,
        max_edges: 100,
    };

    /// web → api → (postgres, payments → external bank); api also calls an uninstrumented host.
    fn trace() -> Vec<Span> {
        vec![
            span("web", SpanKind::Client, 1, None, &[]),
            span("api", SpanKind::Server, 2, Some(1), &[]),
            span(
                "api",
                SpanKind::Client,
                3,
                Some(2),
                &[(DB_SYSTEM_NAME, AttrValue::Str("postgresql".into()))],
            ),
            span("api", SpanKind::Client, 4, Some(2), &[]),
            span("payments", SpanKind::Server, 5, Some(4), &[]),
            span(
                "api",
                SpanKind::Client,
                6,
                Some(2),
                &[(SERVER_ADDRESS, AttrValue::Str("bank".into()))],
            ),
        ]
    }

    /// Nodes and edge counts after feeding `spans` in this order and letting the link window pass.
    fn derive(spans: &[Span]) -> (Vec<String>, Vec<(String, u64, u64)>) {
        let mut graph = Graph::new(ROOMY);
        let mut linker = Linker::new(LIMITS);
        let mut changes = Changes::default();
        for span in spans {
            graph.observe_service(&span.service, NOW, &mut changes);
            for link in linker.on_span(span, 0) {
                graph.record(&link, NOW, &mut changes);
            }
        }
        for link in linker.expire(LIMITS.window_ms) {
            graph.record(&link, NOW, &mut changes);
        }
        let (nodes, edges) = graph.snapshot(0);
        (
            nodes.into_iter().map(|node| node.id).collect(),
            edges
                .into_iter()
                .map(|edge| (edge.key.id(), edge.count, edge.errors))
                .collect(),
        )
    }

    fn permutations(items: &[Span]) -> Vec<Vec<Span>> {
        if items.len() <= 1 {
            return vec![items.to_vec()];
        }
        (0..items.len())
            .flat_map(|i| {
                let mut rest = items.to_vec();
                let first = rest.remove(i);
                permutations(&rest).into_iter().map(move |mut tail| {
                    tail.insert(0, first.clone());
                    tail
                })
            })
            .collect()
    }

    /// I7: linking gives the same graph whatever order the spans arrive in, within the link window.
    #[test]
    fn every_arrival_order_gives_the_same_graph() {
        let expected = derive(&trace());
        assert_eq!(
            expected.1,
            vec![
                ("svc:api->db:postgresql".to_owned(), 1, 0),
                ("svc:api->ext:bank".to_owned(), 1, 0),
                ("svc:api->svc:payments".to_owned(), 1, 0),
                ("svc:web->svc:api".to_owned(), 1, 0),
            ]
        );
        let orders = permutations(&trace());
        assert_eq!(orders.len(), 720);
        for order in orders {
            assert_eq!(derive(&order), expected);
        }
    }

    #[test]
    fn node_and_edge_bounds_ignore_new_ones_and_count_them() {
        let mut graph = Graph::new(GraphLimits {
            max_nodes: 3,
            max_edges: 1,
        });
        let mut changes = Changes::default();
        let mut linker = Linker::new(LIMITS);
        let db = |id| {
            span(
                "api",
                SpanKind::Client,
                id,
                None,
                &[(DB_SYSTEM_NAME, AttrValue::Str(format!("db{id}")))],
            )
        };
        for id in 1..=3 {
            for link in linker.on_span(&db(id), 0) {
                graph.record(&link, NOW, &mut changes);
            }
        }
        let counts = graph.counts();
        assert_eq!((counts.nodes, counts.edges), (3, 1));
        assert_eq!(
            counts.dropped_edges, 1,
            "db2 fits as a node, its edge does not"
        );
        assert_eq!(counts.dropped_nodes, 1, "db3 does not fit as a node");
        assert_eq!(changes.nodes.len(), 3);
    }

    #[test]
    fn repeated_spans_update_nodes_without_new_changes() {
        let mut graph = Graph::new(ROOMY);
        let api = span("api", SpanKind::Server, 2, None, &[]).service;
        let mut first = Changes::default();
        assert!(graph.observe_service(&api, NOW, &mut first));
        let mut second = Changes::default();
        graph.observe_service(
            &api,
            Now {
                mono_ms: 5,
                unix_ns: 9,
            },
            &mut second,
        );
        assert_eq!(first.nodes.len(), 1);
        assert!(second.nodes.is_empty());
        assert_eq!(graph.node("svc:api").unwrap().last_seen_ns, 9);
    }
}
