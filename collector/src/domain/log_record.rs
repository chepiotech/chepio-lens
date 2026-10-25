//! App logs and browser actions. A log can exist without a trace; ids never create synthetic requests or edges.

// Core
use chepio_lens_conventions::keys::{LENS_LOG_KIND, LENS_REDACTION_COUNT};
// Domain
use super::span::{AttrValue, Attributes, Service, SpanId, TraceId};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
}

impl LogLevel {
    pub fn from_otlp(number: i32, text: &str) -> Option<Self> {
        match number {
            1..=4 => Some(Self::Trace),
            5..=8 => Some(Self::Debug),
            9..=12 => Some(Self::Info),
            13..=16 => Some(Self::Warn),
            17..=20 => Some(Self::Error),
            21..=24 => Some(Self::Fatal),
            _ => Self::parse(text),
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text.to_ascii_lowercase().as_str() {
            "trace" => Some(Self::Trace),
            "debug" => Some(Self::Debug),
            "info" => Some(Self::Info),
            "warn" | "warning" => Some(Self::Warn),
            "error" => Some(Self::Error),
            "fatal" => Some(Self::Fatal),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LogRecord {
    pub trace_id: Option<TraceId>,
    pub span_id: Option<SpanId>,
    pub time_ns: u64,
    pub service: Service,
    pub level: Option<LogLevel>,
    pub body: AttrValue,
    pub attributes: Attributes,
    pub truncated: bool,
}

impl LogRecord {
    pub fn approx_size(&self) -> usize {
        128 + self.service.name.len()
            + self.body.approx_size()
            + self
                .attributes
                .iter()
                .map(|(key, value)| key.len() + value.approx_size() + 64)
                .sum::<usize>()
    }

    /// Called only after redaction. Drop excess attributes and shorten the body, retaining a marker.
    pub fn bound(&mut self, limit: usize) {
        let body = self.body.text();
        self.body = AttrValue::Str(body);
        self.truncated |= cut(&mut self.service.name, 256);
        while self.attributes.len() > 64
            || (self.approx_size() - self.body.approx_size() > limit && !self.attributes.is_empty())
        {
            let key = self
                .attributes
                .keys()
                .rev()
                .find(|key| !matches!(key.as_str(), LENS_LOG_KIND | LENS_REDACTION_COUNT))
                .or_else(|| self.attributes.keys().next_back())
                .cloned()
                .unwrap();
            self.attributes.remove(&key);
            self.truncated = true;
        }
        let excess = self.approx_size().saturating_sub(limit);
        if let AttrValue::Str(body) = &mut self.body {
            self.truncated |= cut(body, body.len().saturating_sub(excess));
        }
    }
}

fn cut(text: &mut String, limit: usize) -> bool {
    if text.len() <= limit {
        return false;
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.shrink_to_fit();
    true
}
