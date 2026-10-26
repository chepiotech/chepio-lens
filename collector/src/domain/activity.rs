//! Activities for the logs panel (ADR-0016): a user action with every trace its handler started, a trace without an
//! action, or an action that started nothing. Summaries live in a bounded index updated at ingest from the same log
//! entries the flat log gets; steps are derived on read from the stored spans and records, in call-tree order, never
//! by comparing clocks of different processes (I12, I13).

// Core
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fmt;

use chepio_lens_conventions::keys::{
    DB_NAMESPACE, DB_OPERATION_NAME, DB_QUERY_TEXT, DB_RESPONSE_RETURNED_ROWS, DB_SYSTEM_NAME,
    HTTP_RESPONSE_STATUS_CODE, HTTP_ROUTE, LENS_ACTION_ID, LENS_DB_AFFECTED_ROWS,
    LENS_HTTP_REQUEST_BODY, LENS_HTTP_REQUEST_BODY_TRUNCATED, LENS_HTTP_RESPONSE_BODY,
    LENS_HTTP_RESPONSE_BODY_TRUNCATED, URL_FULL, URL_PATH,
};
// Domain
use super::log::{Layer, LogCursor, LogEntry, LogKind, StatusFilter};
use super::log_record::LogLevel;
use super::node::service_node_id;
use super::span::{AttrValue, Span, SpanId, SpanKind, Status, TraceId};

/// Traces listed per activity; further traces of one action still join it but are not listed.
pub const MAX_TRACES: usize = 64;
/// Steps returned for one activity; the rest are counted as truncated.
pub const MAX_STEPS: usize = 1_000;
/// Longest `lens.action.id` accepted.
const MAX_ACTION_ID: usize = 64;
/// Search text kept per activity: titles, services and line texts.
const MAX_SEARCH_BYTES: usize = 4_096;

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ActivityId {
    /// `lens.action.id`, or `record-<seq>` for an action record without one (older SDKs).
    Action(String),
    Trace(TraceId),
}

impl fmt::Display for ActivityId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Action(id) => write!(f, "action:{id}"),
            Self::Trace(trace) => write!(f, "trace:{trace}"),
        }
    }
}

impl ActivityId {
    pub fn parse(text: &str) -> Option<Self> {
        if let Some(id) = text.strip_prefix("action:") {
            return valid_action_id(id).then(|| Self::Action(id.to_owned()));
        }
        text.strip_prefix("trace:")
            .and_then(TraceId::from_hex)
            .map(Self::Trace)
    }
}

/// `lens.action.id` as an SDK sent it: 1 to 64 characters of `[0-9A-Za-z_-]`; anything else is ignored.
pub fn action_id(value: Option<&str>) -> Option<&str> {
    value.filter(|id| valid_action_id(id))
}

fn valid_action_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ACTION_ID
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// The action id an entry carries: on an action record, or on a span through its attribute (passed in by the store,
/// which has the span).
fn entry_action(entry: &LogEntry, span_action: Option<&str>) -> Option<String> {
    let record_action = entry
        .record
        .as_ref()
        .and_then(|record| record.attributes.get(LENS_ACTION_ID))
        .and_then(AttrValue::as_str);
    action_id(record_action.or(span_action))
        .map(str::to_owned)
        .or_else(|| (entry.kind == LogKind::Action).then(|| format!("record-{}", entry.seq)))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// A click, submit or navigation.
    Action,
    /// A trace without a user action: page load, polling, backend-only traffic.
    Request,
}

/// How a title was chosen; a better source replaces a worse one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum TitleSource {
    FirstLine,
    RootSpan,
    ActionRecord,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ActivitySummary {
    pub id: ActivityId,
    pub origin: Origin,
    /// The action's text, else the root span's line, else the first line that arrived.
    pub title: String,
    /// The action's time, else the root span's start, else the first line's time (as received, I12).
    pub time_ns: u64,
    /// Arrival of the activity's first line; breaks ties in the list.
    pub seq: u64,
    /// Service whose clock `time_ns` is in.
    pub service: String,
    /// From `time_ns` to the last end among lines of that service, so one clock (I12); `None` without such a line.
    pub duration_ns: Option<u64>,
    pub traces: Vec<TraceId>,
    pub traces_unlisted: u64,
    pub layers: BTreeSet<Layer>,
    /// In the order they appeared.
    pub services: Vec<String>,
    pub nodes: BTreeSet<String>,
    pub lines: usize,
    pub error: bool,
    /// Of the root span, or of the action's first root fetch.
    pub status_code: Option<u16>,
    title_source: TitleSource,
    /// Latest line end per service, for `duration_ns`.
    ends: HashMap<String, u64>,
    search: String,
}

impl ActivitySummary {
    fn new(id: ActivityId, entry: &LogEntry) -> Self {
        Self {
            origin: match id {
                ActivityId::Action(_) => Origin::Action,
                ActivityId::Trace(_) => Origin::Request,
            },
            id,
            title: entry.text.clone(),
            time_ns: entry.time_ns,
            seq: entry.seq,
            service: entry.service.clone(),
            duration_ns: None,
            traces: Vec::new(),
            traces_unlisted: 0,
            layers: BTreeSet::new(),
            services: Vec::new(),
            nodes: BTreeSet::new(),
            lines: 0,
            error: false,
            status_code: None,
            title_source: TitleSource::FirstLine,
            ends: HashMap::new(),
            search: String::new(),
        }
    }

    fn cursor(&self) -> LogCursor {
        LogCursor {
            time_ns: self.time_ns,
            seq: self.seq,
        }
    }

    fn add(&mut self, entry: &LogEntry) {
        self.lines += 1;
        self.layers.insert(entry.layer);
        if !self.services.contains(&entry.service) {
            self.services.push(entry.service.clone());
        }
        // Every span passes here: allocate only for what is new.
        for node in &entry.nodes {
            if !self.nodes.contains(node) {
                self.nodes.insert(node.clone());
            }
        }
        self.error |= entry.error;
        if let Some(trace) = entry.trace_id {
            self.list_trace(trace);
        }
        let root = entry.record.is_none() && entry.parent_span_id.is_none();
        let source = match entry.kind {
            LogKind::Action => Some(TitleSource::ActionRecord),
            _ if root => Some(TitleSource::RootSpan),
            _ => None,
        };
        if let Some(source) = source.filter(|source| *source > self.title_source) {
            self.title_source = source;
            self.title = entry.text.clone();
            self.time_ns = entry.time_ns;
            self.service = entry.service.clone();
        }
        if root && self.status_code.is_none() {
            self.status_code = entry.status_code;
        }
        if entry.kind != LogKind::Action && entry.kind != LogKind::Log {
            let end = entry.time_ns.saturating_add(entry.duration_ns);
            match self.ends.get_mut(&entry.service) {
                Some(latest) => *latest = (*latest).max(end),
                None => {
                    self.ends.insert(entry.service.clone(), end);
                }
            }
        }
        self.duration_ns = self
            .ends
            .get(&self.service)
            .map(|end| end.saturating_sub(self.time_ns));
        self.append_search(&entry.search);
    }

    fn list_trace(&mut self, trace: TraceId) {
        if self.traces.contains(&trace) {
            return;
        }
        if self.traces.len() < MAX_TRACES {
            self.traces.push(trace);
        } else {
            self.traces_unlisted += 1;
        }
    }

    fn append_search(&mut self, text: &str) {
        if self.search.len() + text.len() < MAX_SEARCH_BYTES {
            self.search.push_str(text);
            self.search.push('\n');
        }
    }

    /// Takes over a trace activity that turned out to belong to this action.
    fn absorb(&mut self, other: Self) {
        self.lines += other.lines;
        self.layers.extend(other.layers);
        for service in other.services {
            if !self.services.contains(&service) {
                self.services.push(service);
            }
        }
        self.nodes.extend(other.nodes);
        self.error |= other.error;
        for trace in other.traces {
            self.list_trace(trace);
        }
        self.traces_unlisted += other.traces_unlisted;
        if self.status_code.is_none() {
            self.status_code = other.status_code;
        }
        if other.title_source > self.title_source {
            self.title_source = other.title_source;
            self.title = other.title;
            self.time_ns = other.time_ns;
            self.service = other.service;
        }
        self.seq = self.seq.min(other.seq);
        for (service, end) in other.ends {
            let latest = self.ends.entry(service).or_default();
            *latest = (*latest).max(end);
        }
        self.duration_ns = self
            .ends
            .get(&self.service)
            .map(|end| end.saturating_sub(self.time_ns));
        self.append_search(&other.search);
    }
}

/// A changed activity for SSE `activity`, with the ids it absorbed: the UI drops those rows.
#[derive(Debug, Clone, PartialEq)]
pub struct ActivityUpdate {
    pub summary: ActivitySummary,
    pub replaces: Vec<ActivityId>,
}

/// An activity with its steps, for `GET /api/activities/{id}`.
#[derive(Debug, Clone, PartialEq)]
pub struct ActivityDetail {
    pub summary: ActivitySummary,
    pub steps: Steps,
}

/// Collapses the changes of one ingest: each activity once, in order, absorbed activities left out and named on the
/// activity that took them.
pub fn collapse(changes: Vec<ActivityChange>) -> Vec<(ActivityId, Vec<ActivityId>)> {
    let mut updates: Vec<(ActivityId, Vec<ActivityId>)> = Vec::new();
    for change in changes {
        updates.retain(|(id, _)| !change.replaced.contains(id));
        let Some(id) = change.changed else {
            continue;
        };
        match updates.iter_mut().find(|(known, _)| *known == id) {
            Some((_, replaces)) => replaces.extend(change.replaced),
            None => updates.push((id, change.replaced)),
        }
    }
    updates
}

/// What one entry changed: the activity to republish, and the activities it absorbed.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ActivityChange {
    pub changed: Option<ActivityId>,
    pub replaced: Vec<ActivityId>,
}

/// Filters of the activities list; empty fields match everything. An activity matches when any of its lines does.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ActivityQuery {
    pub layers: Vec<Layer>,
    pub node: Option<String>,
    /// Edge id; matched through the traces with a hop on it (passed in by the store).
    pub edge: Option<String>,
    pub status: Option<StatusFilter>,
    pub origins: Vec<Origin>,
    /// Case-insensitive substring of a title, line text, service or trace id.
    pub text: Option<String>,
    pub before: Option<LogCursor>,
    pub limit: usize,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ActivityPage {
    pub activities: Vec<ActivitySummary>,
    pub next_before: Option<LogCursor>,
}

/// Bounded by count; the oldest activity (by time, then arrival) is dropped first.
#[derive(Debug)]
pub struct ActivityIndex {
    activities: HashMap<ActivityId, ActivitySummary>,
    order: BTreeSet<(LogCursor, ActivityId)>,
    by_trace: HashMap<TraceId, ActivityId>,
    max: usize,
    evicted: u64,
}

impl ActivityIndex {
    pub fn new(max: usize) -> Self {
        Self {
            activities: HashMap::new(),
            order: BTreeSet::new(),
            by_trace: HashMap::new(),
            max: max.max(1),
            evicted: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.activities.len()
    }

    pub fn is_empty(&self) -> bool {
        self.activities.is_empty()
    }

    pub fn evicted(&self) -> u64 {
        self.evicted
    }

    pub fn get(&self, id: &ActivityId) -> Option<&ActivitySummary> {
        self.activities.get(id)
    }

    pub fn clear(&mut self) {
        self.activities.clear();
        self.order.clear();
        self.by_trace.clear();
    }

    /// The activity an entry belongs to, without changing anything; `None` for an app log outside any request.
    pub fn owner(&self, entry: &LogEntry, span_action: Option<&str>) -> Option<ActivityId> {
        if let Some(action) = entry_action(entry, span_action) {
            return Some(ActivityId::Action(action));
        }
        let trace = entry.trace_id?;
        Some(
            self.by_trace
                .get(&trace)
                .cloned()
                .unwrap_or(ActivityId::Trace(trace)),
        )
    }

    /// Adds one stored line. `span_action`: the span's `lens.action.id`, for span lines.
    pub fn on_entry(&mut self, entry: &LogEntry, span_action: Option<&str>) -> ActivityChange {
        let mut change = ActivityChange::default();
        let Some(id) = self.owner(entry, span_action) else {
            return change;
        };
        let id = match (&id, entry.trace_id) {
            (ActivityId::Action(_), Some(trace)) => self.claim(trace, id, entry, &mut change),
            (ActivityId::Trace(_), Some(trace)) => {
                self.by_trace.entry(trace).or_insert_with(|| id.clone());
                id
            }
            _ => id,
        };
        self.update(&id, entry);
        change.changed = Some(id);
        self.evict(&mut change);
        change
    }

    /// Links `trace` to the action `id`. A trace that already had an activity of its own is merged into the action;
    /// a trace another action already claimed stays there, and so does this entry.
    fn claim(
        &mut self,
        trace: TraceId,
        id: ActivityId,
        entry: &LogEntry,
        change: &mut ActivityChange,
    ) -> ActivityId {
        match self.by_trace.get(&trace).cloned() {
            None => {
                self.by_trace.insert(trace, id.clone());
                id
            }
            Some(owner) if owner == id => id,
            Some(standalone @ ActivityId::Trace(_)) => {
                self.by_trace.insert(trace, id.clone());
                if let Some(absorbed) = self.remove(&standalone) {
                    for listed in &absorbed.traces {
                        self.by_trace.insert(*listed, id.clone());
                    }
                    self.ensure(&id, entry);
                    let cursor_before = self.activities[&id].cursor();
                    if let Some(summary) = self.activities.get_mut(&id) {
                        summary.absorb(absorbed);
                    }
                    self.rekey(&id, cursor_before);
                    change.replaced.push(standalone);
                }
                id
            }
            Some(other_action) => {
                if entry.kind == LogKind::Action {
                    id
                } else {
                    other_action
                }
            }
        }
    }

    fn ensure(&mut self, id: &ActivityId, entry: &LogEntry) {
        if !self.activities.contains_key(id) {
            let summary = ActivitySummary::new(id.clone(), entry);
            self.order.insert((summary.cursor(), id.clone()));
            self.activities.insert(id.clone(), summary);
        }
    }

    fn update(&mut self, id: &ActivityId, entry: &LogEntry) {
        self.ensure(id, entry);
        let cursor_before = self.activities[id].cursor();
        if let Some(summary) = self.activities.get_mut(id) {
            summary.add(entry);
        }
        self.rekey(id, cursor_before);
    }

    fn rekey(&mut self, id: &ActivityId, before: LogCursor) {
        let after = self.activities[id].cursor();
        if after != before {
            self.order.remove(&(before, id.clone()));
            self.order.insert((after, id.clone()));
        }
    }

    fn remove(&mut self, id: &ActivityId) -> Option<ActivitySummary> {
        let summary = self.activities.remove(id)?;
        self.order.remove(&(summary.cursor(), id.clone()));
        Some(summary)
    }

    fn evict(&mut self, change: &mut ActivityChange) {
        while self.activities.len() > self.max {
            let Some((_, oldest)) = self.order.iter().next().cloned() else {
                return;
            };
            if let Some(summary) = self.remove(&oldest) {
                for trace in &summary.traces {
                    if self.by_trace.get(trace) == Some(&oldest) {
                        self.by_trace.remove(trace);
                    }
                }
            }
            self.evicted += 1;
            if change.changed.as_ref() == Some(&oldest) {
                change.changed = None;
            }
        }
    }

    /// Newest first. `edge_traces`: traces with a hop on `query.edge`.
    pub fn page(&self, query: &ActivityQuery, edge_traces: &HashSet<TraceId>) -> ActivityPage {
        let limit = query.limit.max(1);
        let text = query.text.as_ref().map(|text| text.to_lowercase());
        let mut activities = Vec::new();
        let mut next_before = None;
        let older = self
            .order
            .iter()
            .rev()
            .filter(|(cursor, _)| query.before.is_none_or(|before| *cursor < before));
        for (_, id) in older {
            let summary = &self.activities[id];
            let matches = (query.layers.is_empty()
                || query
                    .layers
                    .iter()
                    .any(|layer| summary.layers.contains(layer)))
                && query
                    .node
                    .as_ref()
                    .is_none_or(|node| summary.nodes.contains(node))
                && (query.edge.is_none()
                    || summary
                        .traces
                        .iter()
                        .any(|trace| edge_traces.contains(trace)))
                && match query.status {
                    None => true,
                    Some(StatusFilter::Error) => summary.error,
                    Some(StatusFilter::Ok) => !summary.error,
                }
                && (query.origins.is_empty() || query.origins.contains(&summary.origin))
                && text.as_ref().is_none_or(|text| {
                    summary.search.contains(text.as_str())
                        || summary.title.to_lowercase().contains(text.as_str())
                });
            if !matches {
                continue;
            }
            if activities.len() == limit {
                next_before = activities.last().map(ActivitySummary::cursor);
                break;
            }
            activities.push(summary.clone());
        }
        ActivityPage {
            activities,
            next_before,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepKind {
    /// Click, submit or navigation.
    Action,
    /// A client sends a request: a browser fetch or a backend's outbound call.
    Send,
    /// A server receives it.
    Receive,
    /// A query goes to the database.
    Query,
    /// The database answers.
    Result,
    /// The server answers.
    Respond,
    /// The client gets the answer.
    Response,
    /// A span of another kind, in one step.
    Span,
    /// An app log line.
    Log,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetailKind {
    Text,
    Json,
    Sql,
}

/// One labelled value of a step; already redacted where it came from (I2). The UI renders it as text (I11).
#[derive(Debug, Clone, PartialEq)]
pub struct Detail {
    pub label: String,
    pub value: String,
    pub kind: DetailKind,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub kind: StepKind,
    pub layer: Layer,
    pub service: String,
    /// The service's node, or the database's for query and result steps.
    pub node: String,
    pub trace_id: Option<TraceId>,
    pub span_id: Option<SpanId>,
    /// In that service's own clock, as received (I12).
    pub time_ns: u64,
    /// On end steps: the span's duration, in one clock.
    pub duration_ns: Option<u64>,
    pub text: String,
    pub status_code: Option<u16>,
    pub error: bool,
    pub level: Option<LogLevel>,
    pub details: Vec<Detail>,
}

/// Steps of an activity with how many were left out over [`MAX_STEPS`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Steps {
    pub steps: Vec<Step>,
    pub truncated: usize,
}

/// The activity's steps: its action records and the call trees of its traces, merged at the top level in time order
/// (they share the browser's clock), then each tree depth first. `traces`: the stored spans per listed trace;
/// `records`: the activity's action and app log entries.
pub fn steps(traces: &[Vec<Span>], records: &[&LogEntry]) -> Steps {
    let spans: Vec<&Span> = traces.iter().flatten().collect();
    let ids: HashSet<(TraceId, SpanId)> = spans
        .iter()
        .map(|span| (span.trace_id, span.span_id))
        .collect();
    let mut children: HashMap<(TraceId, SpanId), Vec<&Span>> = HashMap::new();
    let mut roots: Vec<Top> = Vec::new();
    for span in &spans {
        match span.parent_span_id {
            Some(parent) if ids.contains(&(span.trace_id, parent)) => children
                .entry((span.trace_id, parent))
                .or_default()
                .push(span),
            _ => roots.push(Top::Span(span)),
        }
    }
    let mut logs: HashMap<(TraceId, SpanId), Vec<&LogEntry>> = HashMap::new();
    for record in records {
        match record.trace_id.zip(record.span_id) {
            Some(ids_of) if record.kind == LogKind::Log && ids.contains(&ids_of) => {
                logs.entry(ids_of).or_default().push(record)
            }
            _ => roots.push(Top::Record(record)),
        }
    }
    roots.sort_by_key(|top| (top.time_ns(), top.rank()));
    let tree = Tree { children, logs };
    let mut out = Vec::new();
    for top in roots {
        match top {
            Top::Span(span) => tree.walk(span, &mut out, 0),
            Top::Record(record) => out.push(record_step(record)),
        }
    }
    let truncated = out.len().saturating_sub(MAX_STEPS);
    out.truncate(MAX_STEPS);
    Steps {
        steps: out,
        truncated,
    }
}

enum Top<'a> {
    Span(&'a Span),
    Record(&'a LogEntry),
}

impl Top<'_> {
    fn time_ns(&self) -> u64 {
        match self {
            Self::Span(span) => span.start_ns,
            Self::Record(record) => record.time_ns,
        }
    }

    /// At the same time an action comes before what it started.
    fn rank(&self) -> u8 {
        match self {
            Self::Record(record) if record.kind == LogKind::Action => 0,
            Self::Span(_) => 1,
            Self::Record(_) => 2,
        }
    }
}

/// Bounds the walk on malformed traces; real call trees are far shallower.
const MAX_DEPTH: usize = 64;

struct Tree<'a> {
    children: HashMap<(TraceId, SpanId), Vec<&'a Span>>,
    logs: HashMap<(TraceId, SpanId), Vec<&'a LogEntry>>,
}

enum Own<'a> {
    Span(&'a Span),
    Log(&'a LogEntry),
}

impl Tree<'_> {
    /// A span's start, then the calls it made into other processes, then its own process's children and log lines in
    /// that process's clock order, then its end. Clocks of different processes are never compared (I12).
    fn walk(&self, span: &Span, out: &mut Vec<Step>, depth: usize) {
        if depth > MAX_DEPTH {
            return;
        }
        out.push(start_step(span));
        let key = (span.trace_id, span.span_id);
        let mut other: Vec<&Span> = Vec::new();
        let mut own: Vec<(u64, Own)> = Vec::new();
        for child in self.children.get(&key).into_iter().flatten() {
            if child.service.name == span.service.name {
                own.push((child.start_ns, Own::Span(child)));
            } else {
                other.push(child);
            }
        }
        for log in self.logs.get(&key).into_iter().flatten() {
            own.push((log.time_ns, Own::Log(log)));
        }
        other.sort_by_key(|child| child.start_ns);
        own.sort_by_key(|(time, _)| *time);
        for child in other {
            self.walk(child, out, depth + 1);
        }
        for (_, item) in own {
            match item {
                Own::Span(child) => self.walk(child, out, depth + 1),
                Own::Log(log) => out.push(record_step(log)),
            }
        }
        if let Some(end) = end_step(span) {
            out.push(end);
        }
    }
}

fn step(span: &Span, kind: StepKind, line: &LogEntry) -> Step {
    Step {
        kind,
        layer: line.layer,
        service: span.service.name.clone(),
        node: service_node_id(&span.service.name),
        trace_id: Some(span.trace_id),
        span_id: Some(span.span_id),
        time_ns: span.start_ns,
        duration_ns: None,
        text: line.text.clone(),
        status_code: None,
        error: false,
        level: None,
        details: Vec::new(),
    }
}

fn start_step(span: &Span) -> Step {
    let line = LogEntry::from_span(span, 0);
    match (line.kind, span.kind) {
        (LogKind::Query, _) => {
            let mut step = step(span, StepKind::Query, &line);
            step.node = line.nodes.last().cloned().unwrap_or(step.node);
            step.details = query_details(span);
            step
        }
        (_, SpanKind::Client) => {
            let mut step = step(span, StepKind::Send, &line);
            step.details = body_details(span, "request");
            step
        }
        (_, SpanKind::Server) => {
            let mut step = step(span, StepKind::Receive, &line);
            let mut details = Vec::new();
            for key in [URL_PATH, HTTP_ROUTE] {
                if let Some(value) = span.attr_str(key) {
                    details.push(text_detail(key, value));
                }
            }
            details.extend(body_details(span, "request"));
            step.details = details;
            step
        }
        _ => {
            let mut step = step(span, StepKind::Span, &line);
            step.duration_ns = Some(span.duration_ns());
            step.error = span.is_error();
            step
        }
    }
}

fn end_step(span: &Span) -> Option<Step> {
    let line = LogEntry::from_span(span, 0);
    let kind = match (line.kind, span.kind) {
        (LogKind::Query, _) => StepKind::Result,
        (_, SpanKind::Client) => StepKind::Response,
        (_, SpanKind::Server) => StepKind::Respond,
        _ => return None,
    };
    let mut step = step(span, kind, &line);
    step.time_ns = span.end_ns;
    step.duration_ns = Some(span.duration_ns());
    step.error = span.is_error();
    step.status_code = line.status_code;
    let failure = match &span.status {
        Status::Error { message } if !message.is_empty() => Some(message.clone()),
        _ => None,
    };
    if kind == StepKind::Result {
        step.node = line.nodes.last().cloned().unwrap_or(step.node);
        step.text = rows_text(span);
        if let Some(message) = &failure {
            step.details.push(text_detail("error", message));
        }
        for key in [DB_RESPONSE_RETURNED_ROWS, LENS_DB_AFFECTED_ROWS] {
            if let Some(rows) = span.attr_i64(key) {
                step.details.push(text_detail(key, &rows.to_string()));
            }
        }
    } else {
        step.text = match (line.status_code, step.error) {
            (Some(code), _) => code.to_string(),
            (None, true) => "failed".to_owned(),
            (None, false) => "done".to_owned(),
        };
        if let Some(message) = &failure {
            step.details.push(text_detail("error", message));
        }
        step.details.extend(body_details(span, "response"));
    }
    if failure.is_some() && kind != StepKind::Result {
        step.text = format!("{} · {}", step.text, failure.unwrap_or_default());
    }
    Some(step)
}

/// `3 rows returned`, `1 row affected`, `failed`: what the database answered, without row contents (ADR-0010).
fn rows_text(span: &Span) -> String {
    let rows =
        |count: i64, what: &str| format!("{count} row{} {what}", if count == 1 { "" } else { "s" });
    let reads = span
        .attr_str(DB_OPERATION_NAME)
        .is_none_or(|operation| operation.eq_ignore_ascii_case("SELECT"));
    let mut parts = Vec::new();
    match (
        span.attr_i64(DB_RESPONSE_RETURNED_ROWS),
        span.attr_i64(LENS_DB_AFFECTED_ROWS),
    ) {
        (Some(returned), _) if reads => parts.push(rows(returned, "returned")),
        (_, Some(affected)) => parts.push(rows(affected, "affected")),
        (Some(returned), None) => parts.push(rows(returned, "returned")),
        (None, None) => {}
    }
    if span.is_error() {
        parts.push("failed".to_owned());
    }
    if parts.is_empty() {
        "done".to_owned()
    } else {
        parts.join(" · ")
    }
}

fn query_details(span: &Span) -> Vec<Detail> {
    let mut details = Vec::new();
    if let Some(sql) = span.attr_str(DB_QUERY_TEXT) {
        details.push(Detail {
            label: DB_QUERY_TEXT.to_owned(),
            value: sql.to_owned(),
            kind: DetailKind::Sql,
            truncated: span
                .truncated_attributes
                .iter()
                .any(|key| key == DB_QUERY_TEXT),
        });
    }
    for key in [DB_SYSTEM_NAME, DB_NAMESPACE] {
        if let Some(value) = span.attr_str(key) {
            details.push(text_detail(key, value));
        }
    }
    details
}

/// Headers, then the captured body: `side` is `request` or `response`.
fn body_details(span: &Span, side: &str) -> Vec<Detail> {
    let prefix = format!("http.{side}.header.");
    let headers: Vec<String> = span
        .attributes
        .iter()
        .filter_map(|(key, value)| {
            let name = key.strip_prefix(&prefix)?;
            let value = match value {
                AttrValue::Array(items) => items
                    .iter()
                    .map(AttrValue::text)
                    .collect::<Vec<_>>()
                    .join(", "),
                other => other.text(),
            };
            Some(format!("{name}: {value}"))
        })
        .collect();
    let mut details = Vec::new();
    if let Some(url) = span.attr_str(URL_FULL).filter(|_| side == "request") {
        details.push(text_detail(URL_FULL, url));
    }
    if !headers.is_empty() {
        details.push(Detail {
            label: format!("{side} headers"),
            value: headers.join("\n"),
            kind: DetailKind::Text,
            truncated: false,
        });
    }
    let (body_key, truncated_key) = match side {
        "request" => (LENS_HTTP_REQUEST_BODY, LENS_HTTP_REQUEST_BODY_TRUNCATED),
        _ => (LENS_HTTP_RESPONSE_BODY, LENS_HTTP_RESPONSE_BODY_TRUNCATED),
    };
    if let Some(body) = span.attr_str(body_key) {
        let json = span
            .attributes
            .get(&format!("http.{side}.header.content-type"))
            .is_some_and(|value| value.text().contains("json"));
        details.push(Detail {
            label: format!("{side} body"),
            value: body.to_owned(),
            kind: if json {
                DetailKind::Json
            } else {
                DetailKind::Text
            },
            truncated: span
                .attributes
                .get(truncated_key)
                .is_some_and(|value| *value == AttrValue::Bool(true)),
        });
    }
    if let Some(code) = span
        .attr_i64(HTTP_RESPONSE_STATUS_CODE)
        .filter(|_| side == "response")
    {
        details.insert(0, text_detail(HTTP_RESPONSE_STATUS_CODE, &code.to_string()));
    }
    details
}

fn record_step(entry: &LogEntry) -> Step {
    let mut details = Vec::new();
    if let Some(record) = &entry.record {
        let body = record.body.text();
        if body != entry.text {
            details.push(text_detail("message", &body));
        }
        let attributes: Vec<String> = record
            .attributes
            .iter()
            .map(|(key, value)| format!("{key}: {}", value.text()))
            .collect();
        if !attributes.is_empty() {
            details.push(Detail {
                label: "attributes".to_owned(),
                value: attributes.join("\n"),
                kind: DetailKind::Text,
                truncated: record.truncated,
            });
        }
    }
    Step {
        kind: if entry.kind == LogKind::Action {
            StepKind::Action
        } else {
            StepKind::Log
        },
        layer: entry.layer,
        service: entry.service.clone(),
        node: service_node_id(&entry.service),
        trace_id: entry.trace_id,
        span_id: entry.span_id,
        time_ns: entry.time_ns,
        duration_ns: None,
        text: entry.text.clone(),
        status_code: None,
        error: entry.error,
        level: entry.level,
        details,
    }
}

fn text_detail(label: &str, value: &str) -> Detail {
    Detail {
        label: label.to_owned(),
        value: value.to_owned(),
        kind: DetailKind::Text,
        truncated: false,
    }
}

#[cfg(test)]
mod tests {
    // Core
    use chepio_lens_conventions::keys::{
        DB_SYSTEM_NAME, HTTP_REQUEST_METHOD, LENS_LOG_KIND, SERVER_ADDRESS,
    };

    use super::*;
    use crate::domain::linker::tests::span;
    use crate::domain::log_record::LogRecord;
    use crate::domain::span::{Attributes, Service, ServiceKind};

    const ACTION: &str = "0123456789abcdef";

    fn browser(mut span: Span) -> Span {
        span.service = Service {
            name: "web".into(),
            kind: ServiceKind::Frontend,
        };
        span
    }

    /// One demo "Delete": the browser's fetch (1), the API's server span (2) and its query (3), with the browser
    /// clock 10 s ahead of the server's, so any ordering by timestamps across processes would be wrong.
    fn delete_trace() -> Vec<Span> {
        let mut fetch = browser(span(
            "web",
            SpanKind::Client,
            1,
            None,
            &[
                (HTTP_REQUEST_METHOD, AttrValue::Str("DELETE".into())),
                (
                    URL_FULL,
                    AttrValue::Str("http://localhost:5173/api/notes/7".into()),
                ),
                (HTTP_RESPONSE_STATUS_CODE, AttrValue::Int(204)),
                (LENS_ACTION_ID, AttrValue::Str(ACTION.into())),
            ],
        ));
        fetch.start_ns = 10_000_000_000;
        fetch.end_ns = 10_050_000_000;
        let mut server = span(
            "api",
            SpanKind::Server,
            2,
            Some(1),
            &[
                (HTTP_ROUTE, AttrValue::Str("/api/notes/{id}".into())),
                (HTTP_RESPONSE_STATUS_CODE, AttrValue::Int(204)),
            ],
        );
        server.name = "DELETE /api/notes/{id}".into();
        server.start_ns = 1_000_000;
        server.end_ns = 4_000_000;
        let mut query = span(
            "api",
            SpanKind::Client,
            3,
            Some(2),
            &[
                (DB_SYSTEM_NAME, AttrValue::Str("postgresql".into())),
                (SERVER_ADDRESS, AttrValue::Str("db".into())),
                (
                    DB_QUERY_TEXT,
                    AttrValue::Str("DELETE FROM notes WHERE id = $1".into()),
                ),
                (DB_OPERATION_NAME, AttrValue::Str("DELETE".into())),
                (DB_RESPONSE_RETURNED_ROWS, AttrValue::Int(0)),
                (LENS_DB_AFFECTED_ROWS, AttrValue::Int(1)),
            ],
        );
        query.start_ns = 2_000_000;
        query.end_ns = 3_000_000;
        vec![fetch, server, query]
    }

    fn record(
        kind: &str,
        body: &str,
        time_ns: u64,
        trace: Option<(TraceId, SpanId)>,
        seq: u64,
    ) -> LogEntry {
        let mut attributes = Attributes::new();
        if kind == "action" {
            attributes.insert(LENS_LOG_KIND.into(), AttrValue::Str("action".into()));
            attributes.insert(LENS_ACTION_ID.into(), AttrValue::Str(ACTION.into()));
        }
        let service = if kind == "action" { "web" } else { "api" };
        LogEntry::from_record(
            LogRecord {
                trace_id: trace.map(|(trace, _)| trace),
                span_id: trace.map(|(_, span)| span),
                time_ns,
                service: Service {
                    name: service.into(),
                    kind: if kind == "action" {
                        ServiceKind::Frontend
                    } else {
                        ServiceKind::Service
                    },
                },
                level: Some(LogLevel::Info),
                body: AttrValue::Str(body.into()),
                attributes,
                truncated: false,
            },
            seq,
        )
    }

    fn click(seq: u64) -> LogEntry {
        let first_fetch = Some((TraceId([7; 16]), SpanId([1; 8])));
        record("action", "click Delete", 9_999_000_000, first_fetch, seq)
    }

    fn everything() -> ActivityQuery {
        ActivityQuery {
            limit: 100,
            ..ActivityQuery::default()
        }
    }

    fn span_action(span: &Span) -> Option<&str> {
        span.attr_str(LENS_ACTION_ID)
    }

    /// Every line of the "Delete": the action record and the three spans, as the store would build them.
    fn lines() -> Vec<(LogEntry, Option<String>)> {
        let mut lines: Vec<(LogEntry, Option<String>)> = delete_trace()
            .iter()
            .enumerate()
            .map(|(seq, span)| {
                (
                    LogEntry::from_span(span, seq as u64),
                    span_action(span).map(str::to_owned),
                )
            })
            .collect();
        lines.push((click(3), None));
        lines
    }

    fn permutations<T: Clone>(items: &[T]) -> Vec<Vec<T>> {
        if items.len() <= 1 {
            return vec![items.to_vec()];
        }
        let mut all = Vec::new();
        for index in 0..items.len() {
            let mut rest = items.to_vec();
            let first = rest.remove(index);
            for mut tail in permutations(&rest) {
                tail.insert(0, first.clone());
                all.push(tail);
            }
        }
        all
    }

    // I13: one activity per action, whatever the arrival order of its spans and its record.
    #[test]
    fn an_action_and_its_trace_are_one_activity_in_every_arrival_order() {
        for order in permutations(&lines()) {
            let mut index = ActivityIndex::new(100);
            for (entry, action) in &order {
                index.on_entry(entry, action.as_deref());
            }
            let page = index.page(&everything(), &HashSet::new());
            assert_eq!(page.activities.len(), 1, "{order:#?}");
            let activity = &page.activities[0];
            assert_eq!(activity.id, ActivityId::Action(ACTION.into()));
            assert_eq!(activity.origin, Origin::Action);
            assert_eq!(activity.title, "click Delete");
            assert_eq!(activity.time_ns, 9_999_000_000);
            assert_eq!(activity.lines, 4);
            assert_eq!(activity.traces, vec![TraceId([7; 16])]);
            assert_eq!(
                activity.layers,
                BTreeSet::from([Layer::Frontend, Layer::Backend, Layer::Database])
            );
            assert_eq!(activity.status_code, Some(204));
            // From the click to the end of the fetch, both in the browser's clock.
            assert_eq!(activity.duration_ns, Some(51_000_000));
        }
    }

    #[test]
    fn a_trace_that_turns_out_to_belong_to_an_action_is_merged_and_named_as_replaced() {
        let mut index = ActivityIndex::new(100);
        let spans = delete_trace();
        // The API's spans arrive first and carry no action id: the trace gets an activity of its own.
        let server = index.on_entry(&LogEntry::from_span(&spans[1], 0), None);
        assert_eq!(server.changed, Some(ActivityId::Trace(TraceId([7; 16]))));
        index.on_entry(&LogEntry::from_span(&spans[2], 1), None);
        // The browser's fetch names the action.
        let fetch = index.on_entry(&LogEntry::from_span(&spans[0], 2), span_action(&spans[0]));

        assert_eq!(fetch.changed, Some(ActivityId::Action(ACTION.into())));
        assert_eq!(fetch.replaced, vec![ActivityId::Trace(TraceId([7; 16]))]);
        assert_eq!(index.len(), 1);
        assert_eq!(
            index.get(&ActivityId::Action(ACTION.into())).unwrap().lines,
            3
        );
    }

    #[test]
    fn requests_without_an_action_and_clicks_without_a_request_are_activities_of_their_own() {
        let mut index = ActivityIndex::new(100);
        let mut load = browser(span("web", SpanKind::Client, 9, None, &[]));
        load.trace_id = TraceId([9; 16]);
        index.on_entry(&LogEntry::from_span(&load, 0), None);
        let mut lone = record("action", "click li (2 of 3) in ul#notes", 50, None, 1);
        if let Some(record) = lone.record.as_mut() {
            record.attributes.insert(
                LENS_ACTION_ID.into(),
                AttrValue::Str("feedfacecafebeef".into()),
            );
        }
        index.on_entry(&lone, None);
        // An app log outside any request stays in the flat log only.
        let outside = index.on_entry(&record("log", "started", 60, None, 2), None);

        assert_eq!(outside, ActivityChange::default());
        let page = index.page(&everything(), &HashSet::new());
        let ids: Vec<String> = page
            .activities
            .iter()
            .map(|activity| activity.id.to_string())
            .collect();
        assert_eq!(
            ids,
            vec![
                format!("trace:{}", TraceId([9; 16])),
                "action:feedfacecafebeef".to_owned()
            ]
        );
        assert_eq!(page.activities[1].duration_ns, None);
    }

    #[test]
    fn action_records_without_an_id_still_form_one_activity_with_their_trace() {
        let mut index = ActivityIndex::new(100);
        let mut old = click(5);
        if let Some(record) = old.record.as_mut() {
            record.attributes.remove(LENS_ACTION_ID);
        }
        index.on_entry(&old, None);
        let spans = delete_trace();
        for (seq, span) in spans.iter().enumerate() {
            index.on_entry(&LogEntry::from_span(span, seq as u64 + 10), None);
        }
        let page = index.page(&everything(), &HashSet::new());
        assert_eq!(page.activities.len(), 1);
        assert_eq!(page.activities[0].id, ActivityId::Action("record-5".into()));
        assert_eq!(page.activities[0].lines, 4);
    }

    #[test]
    fn invalid_action_ids_are_ignored() {
        assert_eq!(action_id(Some(ACTION)), Some(ACTION));
        assert_eq!(action_id(Some("")), None);
        assert_eq!(action_id(Some("a/b")), None);
        assert_eq!(action_id(Some(&"a".repeat(65))), None);
        assert_eq!(ActivityId::parse("action:a/b"), None);
        assert_eq!(
            ActivityId::parse(&format!("trace:{}", TraceId([7; 16]))),
            Some(ActivityId::Trace(TraceId([7; 16])))
        );
        assert_eq!(ActivityId::parse("span:1"), None);
    }

    // I9: the index is bounded by count; the oldest activity goes first and its traces are forgotten.
    #[test]
    fn the_oldest_activity_is_evicted_beyond_the_bound() {
        let mut index = ActivityIndex::new(2);
        for n in 1..=3u8 {
            let mut fetch = browser(span("web", SpanKind::Client, n, None, &[]));
            fetch.trace_id = TraceId([n; 16]);
            let change = index.on_entry(&LogEntry::from_span(&fetch, u64::from(n)), None);
            assert_eq!(change.changed, Some(ActivityId::Trace(TraceId([n; 16]))));
        }
        assert_eq!(index.len(), 2);
        assert_eq!(index.evicted(), 1);
        assert!(index.get(&ActivityId::Trace(TraceId([1; 16]))).is_none());
    }

    #[test]
    fn filters_match_any_line_of_an_activity_and_pages_continue_older() {
        let mut index = ActivityIndex::new(100);
        for (entry, action) in lines() {
            index.on_entry(&entry, action.as_deref());
        }
        for n in 1..=3u8 {
            let mut fetch = browser(span("web", SpanKind::Client, n, None, &[]));
            fetch.trace_id = TraceId([100 + n; 16]);
            fetch.start_ns = u64::from(n);
            index.on_entry(&LogEntry::from_span(&fetch, 100 + u64::from(n)), None);
        }
        let query = |change: fn(&mut ActivityQuery)| {
            let mut query = ActivityQuery {
                limit: 10,
                ..ActivityQuery::default()
            };
            change(&mut query);
            index.page(&query, &HashSet::new()).activities.len()
        };
        assert_eq!(query(|_| {}), 4);
        assert_eq!(query(|q| q.layers = vec![Layer::Database]), 1);
        assert_eq!(query(|q| q.node = Some("db:postgresql:db".into())), 1);
        assert_eq!(query(|q| q.origins = vec![Origin::Action]), 1);
        assert_eq!(query(|q| q.text = Some("NOTES WHERE".into())), 1);
        assert_eq!(query(|q| q.status = Some(StatusFilter::Error)), 0);

        let first = index.page(
            &ActivityQuery {
                limit: 2,
                ..ActivityQuery::default()
            },
            &HashSet::new(),
        );
        assert_eq!(first.activities.len(), 2);
        let rest = index.page(
            &ActivityQuery {
                limit: 10,
                before: first.next_before,
                ..ActivityQuery::default()
            },
            &HashSet::new(),
        );
        assert_eq!(rest.activities.len(), 2);
        assert!(rest.next_before.is_none());
    }

    // I13: steps follow the call tree there and back, though the browser's clock is 10 s ahead of the server's.
    #[test]
    fn steps_follow_the_call_tree_there_and_back_with_skewed_clocks() {
        let spans = delete_trace();
        let action = click(3);
        let inside = record(
            "log",
            "deleting note",
            1_500_000,
            Some((TraceId([7; 16]), SpanId([2; 8]))),
            4,
        );
        let records = [&action, &inside];
        let result = steps(&[spans], &records);

        let kinds: Vec<StepKind> = result.steps.iter().map(|step| step.kind).collect();
        assert_eq!(
            kinds,
            vec![
                StepKind::Action,
                StepKind::Send,
                StepKind::Receive,
                StepKind::Log,
                StepKind::Query,
                StepKind::Result,
                StepKind::Respond,
                StepKind::Response,
            ]
        );
        let texts: Vec<&str> = result.steps.iter().map(|step| step.text.as_str()).collect();
        assert_eq!(
            texts,
            vec![
                "click Delete",
                "DELETE localhost:5173/api/notes/7",
                "DELETE /api/notes/{id}",
                "deleting note",
                "DELETE FROM notes WHERE id = $1",
                "1 row affected",
                "204",
                "204",
            ]
        );
        let result_step = &result.steps[5];
        assert_eq!(result_step.duration_ns, Some(1_000_000));
        assert_eq!(result_step.node, "db:postgresql:db");
        assert!(
            result_step
                .details
                .contains(&text_detail(LENS_DB_AFFECTED_ROWS, "1"))
        );
        assert_eq!(result.truncated, 0);
    }

    #[test]
    fn several_fetches_of_one_action_follow_the_browser_clock() {
        let mut first = delete_trace();
        let mut second = delete_trace();
        for span in &mut second {
            span.trace_id = TraceId([8; 16]);
        }
        // The second fetch started later in the browser's clock, its server earlier in the server's.
        second[0].start_ns += 5_000_000;
        second[0].end_ns += 5_000_000;
        second[1].start_ns = 0;
        first.truncate(1);
        second.truncate(2);
        let result = steps(&[second, first], &[]);
        let traces: Vec<Option<TraceId>> = result.steps.iter().map(|step| step.trace_id).collect();
        assert_eq!(
            traces,
            vec![
                Some(TraceId([7; 16])),
                Some(TraceId([7; 16])),
                Some(TraceId([8; 16])),
                Some(TraceId([8; 16])),
                Some(TraceId([8; 16])),
                Some(TraceId([8; 16])),
            ]
        );
    }

    #[test]
    fn steps_are_bounded() {
        let mut spans = Vec::new();
        for n in 0..600u16 {
            let mut child = span("api", SpanKind::Client, 2, Some(1), &[]);
            child.span_id = SpanId([(n % 256) as u8, (n / 256) as u8, 9, 9, 9, 9, 9, 9]);
            spans.push(child);
        }
        spans.push(span("api", SpanKind::Server, 1, None, &[]));
        let result = steps(&[spans], &[]);
        assert_eq!(result.steps.len(), MAX_STEPS);
        assert_eq!(result.truncated, 1_202 - MAX_STEPS);
    }
}
