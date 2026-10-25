// Domain
use super::span::{SpanId, TraceId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Protocol {
    Http,
    Db,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct EdgeKey {
    pub from: String,
    pub to: String,
    pub protocol: Protocol,
}

impl EdgeKey {
    /// `<from>-><to>`; unique, because http and db edges never share a target node.
    pub fn id(&self) -> String {
        format!("{}->{}", self.from, self.to)
    }
}

/// Four buckets per doubling from 1 µs; the last bucket (≈ 1 h) also takes everything longer.
const BUCKETS: usize = 128;

/// Latency distribution with fixed memory; quantiles are bucket upper bounds, at most ~19% above the true value.
#[derive(Debug, Clone, PartialEq)]
pub struct LatencyHistogram {
    buckets: [u64; BUCKETS],
    count: u64,
}

impl Default for LatencyHistogram {
    fn default() -> Self {
        Self {
            buckets: [0; BUCKETS],
            count: 0,
        }
    }
}

impl LatencyHistogram {
    fn bucket_of(duration_ns: u64) -> usize {
        let micros = (duration_ns as f64 / 1_000.0).max(1.0);
        ((micros.log2() * 4.0).ceil() as usize).min(BUCKETS - 1)
    }

    fn upper_bound_ns(bucket: usize) -> u64 {
        (2f64.powf(bucket as f64 / 4.0) * 1_000.0).round() as u64
    }

    pub fn record(&mut self, duration_ns: u64) {
        self.buckets[Self::bucket_of(duration_ns)] += 1;
        self.count += 1;
    }

    /// Upper bound of the bucket holding quantile `q` (0..=1); 0 when empty.
    pub fn quantile_ns(&self, q: f64) -> u64 {
        if self.count == 0 {
            return 0;
        }
        let rank = ((q * self.count as f64).ceil() as u64).max(1);
        let mut seen = 0;
        for (bucket, count) in self.buckets.iter().enumerate() {
            seen += count;
            if seen >= rank {
                return Self::upper_bound_ns(bucket);
            }
        }
        Self::upper_bound_ns(BUCKETS - 1)
    }
}

const RATE_WINDOW_SECONDS: u64 = 60;

/// Requests per second over the last 60 seconds, with one slot per second.
#[derive(Debug, Clone, PartialEq)]
pub struct RateWindow {
    /// (second, count) per slot; a slot belongs to the window only while its second is recent.
    slots: [(u64, u32); RATE_WINDOW_SECONDS as usize],
}

impl Default for RateWindow {
    fn default() -> Self {
        Self {
            slots: [(0, 0); RATE_WINDOW_SECONDS as usize],
        }
    }
}

impl RateWindow {
    pub fn record(&mut self, now_mono_ms: u64) {
        let second = now_mono_ms / 1_000;
        let slot = &mut self.slots[(second % RATE_WINDOW_SECONDS) as usize];
        if slot.0 == second {
            slot.1 += 1;
        } else {
            *slot = (second, 1);
        }
    }

    pub fn per_second(&self, now_mono_ms: u64) -> f64 {
        let now = now_mono_ms / 1_000;
        let recent: u32 = self
            .slots
            .iter()
            .filter(|(second, _)| *second <= now && now - *second < RATE_WINDOW_SECONDS)
            .map(|(_, count)| count)
            .sum();
        f64::from(recent) / RATE_WINDOW_SECONDS as f64
    }
}

/// Routes counted per edge; calls to further routes are counted under [`OTHER_ROUTES`] (I9).
pub const MAX_ROUTES_PER_EDGE: usize = 16;
pub const OTHER_ROUTES: &str = "(other routes)";

/// Calls of one route of the callee: count, errors and timing without a histogram, to keep edges small.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RouteStats {
    pub count: u64,
    pub errors: u64,
    pub total_ns: u64,
    pub max_ns: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Edge {
    pub key: EdgeKey,
    pub count: u64,
    pub errors: u64,
    pub latency: LatencyHistogram,
    pub rate: RateWindow,
    pub routes: std::collections::BTreeMap<String, RouteStats>,
    latest_call: Option<LatestCall>,
    pub first_seen_ns: u64,
    pub last_seen_ns: u64,
}

/// Caller-clock completion time, with stable tie breakers for batches arriving in any order (I7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct CallOrder {
    pub end_ns: u64,
    pub trace_id: TraceId,
    pub span_id: SpanId,
}

#[derive(Debug, Clone, PartialEq)]
struct LatestCall {
    order: CallOrder,
    duration_ns: u64,
    error: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RouteSnapshot {
    pub route: String,
    pub count: u64,
    pub errors: u64,
    pub mean_ns: u64,
    pub max_ns: u64,
}

/// An edge's numbers at one moment, as the UI API reports them.
#[derive(Debug, Clone, PartialEq)]
pub struct EdgeSnapshot {
    pub key: EdgeKey,
    pub count: u64,
    pub errors: u64,
    pub last_error: bool,
    pub last_duration_ns: u64,
    pub p50_ns: u64,
    pub p95_ns: u64,
    pub rate_per_second: f64,
    /// Most called first.
    pub routes: Vec<RouteSnapshot>,
    pub last_seen_ns: u64,
}

impl Edge {
    pub fn new(key: EdgeKey, now_unix_ns: u64) -> Self {
        Self {
            key,
            count: 0,
            errors: 0,
            latency: LatencyHistogram::default(),
            rate: RateWindow::default(),
            routes: std::collections::BTreeMap::new(),
            latest_call: None,
            first_seen_ns: now_unix_ns,
            last_seen_ns: now_unix_ns,
        }
    }

    pub fn record(
        &mut self,
        route: &str,
        duration_ns: u64,
        error: bool,
        now_mono_ms: u64,
        now_unix_ns: u64,
        order: CallOrder,
    ) {
        self.count += 1;
        self.errors += u64::from(error);
        self.latency.record(duration_ns);
        self.rate.record(now_mono_ms);
        self.last_seen_ns = now_unix_ns;
        if self
            .latest_call
            .as_ref()
            .is_none_or(|last| order > last.order)
        {
            self.latest_call = Some(LatestCall {
                order,
                duration_ns,
                error,
            });
        }
        let route = if self.routes.contains_key(route) || self.routes.len() < MAX_ROUTES_PER_EDGE {
            route
        } else {
            OTHER_ROUTES
        };
        let stats = self.routes.entry(route.to_owned()).or_default();
        stats.count += 1;
        stats.errors += u64::from(error);
        stats.total_ns = stats.total_ns.saturating_add(duration_ns);
        stats.max_ns = stats.max_ns.max(duration_ns);
    }

    pub fn snapshot(&self, now_mono_ms: u64) -> EdgeSnapshot {
        EdgeSnapshot {
            key: self.key.clone(),
            count: self.count,
            errors: self.errors,
            last_error: self.latest_call.as_ref().is_some_and(|call| call.error),
            last_duration_ns: self.latest_call.as_ref().map_or(0, |call| call.duration_ns),
            p50_ns: self.latency.quantile_ns(0.5),
            p95_ns: self.latency.quantile_ns(0.95),
            rate_per_second: self.rate.per_second(now_mono_ms),
            routes: {
                let mut routes: Vec<RouteSnapshot> = self
                    .routes
                    .iter()
                    .map(|(route, stats)| RouteSnapshot {
                        route: route.clone(),
                        count: stats.count,
                        errors: stats.errors,
                        mean_ns: stats.total_ns / stats.count.max(1),
                        max_ns: stats.max_ns,
                    })
                    .collect();
                routes.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.route.cmp(&b.route)));
                routes
            },
            last_seen_ns: self.last_seen_ns,
        }
    }
}

#[cfg(test)]
mod tests {
    // Core
    use super::*;

    fn order(end_ns: u64) -> CallOrder {
        CallOrder {
            end_ns,
            trace_id: TraceId([1; 16]),
            span_id: SpanId([1; 8]),
        }
    }

    #[test]
    fn routes_are_counted_per_edge_up_to_the_bound() {
        let key = EdgeKey {
            from: "svc:web".into(),
            to: "svc:api".into(),
            protocol: Protocol::Http,
        };
        let mut edge = Edge::new(key, 0);
        edge.record("GET /api/notes", 2_000_000, false, 0, 0, order(2_000_000));
        edge.record("GET /api/notes", 4_000_000, true, 0, 0, order(4_000_000));
        for i in 0..MAX_ROUTES_PER_EDGE + 2 {
            edge.record(
                &format!("GET /r{i}"),
                1_000,
                false,
                0,
                0,
                order(5_000_000 + i as u64),
            );
        }

        let routes = edge.snapshot(0).routes;

        assert_eq!(routes.len(), MAX_ROUTES_PER_EDGE + 1);
        // Most called first: the three calls past the bound outnumber the two to /api/notes.
        assert_eq!(
            (routes[0].route.as_str(), routes[0].count),
            (OTHER_ROUTES, 3)
        );
        assert_eq!(
            routes[1],
            RouteSnapshot {
                route: "GET /api/notes".into(),
                count: 2,
                errors: 1,
                mean_ns: 3_000_000,
                max_ns: 4_000_000,
            }
        );
    }

    #[test]
    fn histogram_quantiles_are_close_upper_bounds() {
        let mut histogram = LatencyHistogram::default();
        assert_eq!(histogram.quantile_ns(0.5), 0);
        // 90 fast requests (1 ms) and 10 slow ones (300 ms).
        (0..90).for_each(|_| histogram.record(1_000_000));
        (0..10).for_each(|_| histogram.record(300_000_000));
        let p50 = histogram.quantile_ns(0.5);
        let p95 = histogram.quantile_ns(0.95);
        assert!((1_000_000..=1_190_000).contains(&p50), "p50 = {p50}");
        assert!((300_000_000..=357_000_000).contains(&p95), "p95 = {p95}");
    }

    #[test]
    fn histogram_clamps_tiny_and_huge_durations() {
        let mut histogram = LatencyHistogram::default();
        histogram.record(0);
        assert_eq!(histogram.quantile_ns(1.0), 1_000);
        histogram.record(u64::MAX);
        assert!(histogram.quantile_ns(1.0) > 3_000_000_000_000);
    }

    #[test]
    fn rate_counts_only_the_last_60_seconds() {
        let mut rate = RateWindow::default();
        (0..30).for_each(|_| rate.record(1_000));
        (0..30).for_each(|_| rate.record(30_500));
        assert_eq!(rate.per_second(30_500), 1.0);
        // At 61 s the first second has left the window.
        assert_eq!(rate.per_second(61_000), 0.5);
        assert_eq!(rate.per_second(200_000), 0.0);
    }

    #[test]
    fn edge_records_counts_errors_and_latency() {
        let key = EdgeKey {
            from: "svc:a".into(),
            to: "svc:b".into(),
            protocol: Protocol::Http,
        };
        let mut edge = Edge::new(key, 10);
        edge.record("GET /a", 2_000_000, false, 1_000, 20, order(2_000_000));
        edge.record("GET /a", 4_000_000, true, 1_500, 30, order(4_000_000));
        let snapshot = edge.snapshot(1_500);
        assert_eq!(
            (snapshot.count, snapshot.errors, snapshot.last_seen_ns),
            (2, 1, 30)
        );
        assert_eq!(snapshot.key.id(), "svc:a->svc:b");
        assert!(snapshot.p95_ns >= 4_000_000);
        assert!(
            snapshot.last_error,
            "a newer failed call changes the current result"
        );
        assert_eq!(snapshot.last_duration_ns, 4_000_000);
    }
}
