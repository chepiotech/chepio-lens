// Core
use std::collections::BTreeMap;
use std::fmt;

use chepio_lens_conventions::keys::{HTTP_RESPONSE_STATUS_CODE, LANGUAGE_WEBJS};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TraceId(pub [u8; 16]);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SpanId(pub [u8; 8]);

impl TraceId {
    /// `None` unless `bytes` has 16 bytes and is not all zeros (W3C Trace Context).
    pub fn from_slice(bytes: &[u8]) -> Option<Self> {
        let id: [u8; 16] = bytes.try_into().ok()?;
        (id != [0; 16]).then_some(Self(id))
    }
}

impl TraceId {
    /// Parses the 32 lowercase or uppercase hex digits of `Display`.
    pub fn from_hex(text: &str) -> Option<Self> {
        if text.len() != 32 || !text.is_ascii() {
            return None;
        }
        let bytes: Option<Vec<u8>> = (0..16)
            .map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).ok())
            .collect();
        Self::from_slice(&bytes?)
    }
}

impl SpanId {
    /// `None` unless `bytes` has 8 bytes and is not all zeros.
    pub fn from_slice(bytes: &[u8]) -> Option<Self> {
        let id: [u8; 8] = bytes.try_into().ok()?;
        (id != [0; 8]).then_some(Self(id))
    }
}

fn write_hex(f: &mut fmt::Formatter<'_>, bytes: &[u8]) -> fmt::Result {
    bytes.iter().try_for_each(|byte| write!(f, "{byte:02x}"))
}

impl fmt::Display for TraceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write_hex(f, &self.0)
    }
}

impl fmt::Display for SpanId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write_hex(f, &self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpanKind {
    Unspecified,
    Internal,
    Server,
    Client,
    Producer,
    Consumer,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    Unset,
    Ok,
    Error { message: String },
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(untagged)]
pub enum AttrValue {
    Str(String),
    Bool(bool),
    Int(i64),
    Double(f64),
    Array(Vec<AttrValue>),
    Map(BTreeMap<String, AttrValue>),
}

impl AttrValue {
    /// Structured values remain structured until after masking; text is safe for text-only UI rendering.
    pub fn text(&self) -> String {
        match self {
            Self::Str(text) => text.clone(),
            _ => serde_json::to_string(self).unwrap_or_default(),
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Str(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Self::Int(value) => Some(*value),
            _ => None,
        }
    }

    /// Rough number of bytes the value holds, for the store's byte bound.
    pub fn approx_size(&self) -> usize {
        match self {
            Self::Str(value) => value.len(),
            Self::Array(items) => {
                items
                    .iter()
                    .map(|item| item.approx_size() + 32)
                    .sum::<usize>()
                    + 24
            }
            Self::Map(items) => {
                items
                    .iter()
                    .map(|(key, value)| key.len() + value.approx_size() + 64)
                    .sum::<usize>()
                    + 24
            }
            _ => 8,
        }
    }
}

/// Attributes with normalized (stable) names.
pub type Attributes = BTreeMap<String, AttrValue>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ServiceKind {
    Frontend,
    Service,
}

/// The service that emitted a span, resolved from its resource (I3).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Service {
    pub name: String,
    pub kind: ServiceKind,
}

/// OpenTelemetry's name for a resource without `service.name`.
pub const UNKNOWN_SERVICE: &str = "unknown_service";

impl Service {
    /// `lens.node.kind` wins when it is `frontend` or `service`; otherwise `telemetry.sdk.language = webjs` means
    /// frontend (I3).
    pub fn from_resource(
        name: Option<&str>,
        language: Option<&str>,
        kind_override: Option<&str>,
    ) -> Self {
        let kind = match (kind_override, language) {
            (Some("frontend"), _) => ServiceKind::Frontend,
            (Some("service"), _) => ServiceKind::Service,
            (_, Some(LANGUAGE_WEBJS)) => ServiceKind::Frontend,
            _ => ServiceKind::Service,
        };
        let name = name
            .filter(|name| !name.is_empty())
            .unwrap_or(UNKNOWN_SERVICE);
        Self {
            name: name.to_owned(),
            kind,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Span {
    pub trace_id: TraceId,
    pub span_id: SpanId,
    pub parent_span_id: Option<SpanId>,
    pub service: Service,
    pub kind: SpanKind,
    pub name: String,
    pub start_ns: u64,
    pub end_ns: u64,
    pub status: Status,
    pub attributes: Attributes,
    /// Attributes cut to the collector's value limit.
    pub truncated_attributes: Vec<String>,
    /// Span events (`exception`, browser timing), at most the collector's per-span bound, in arrival order.
    pub events: Vec<SpanEvent>,
}

/// Something that happened during a span, e.g. an `exception` with its message and stack trace.
#[derive(Debug, Clone, PartialEq)]
pub struct SpanEvent {
    pub name: String,
    pub time_ns: u64,
    pub attributes: Attributes,
    /// Event attribute keys whose values were cut to the collector's value limit.
    pub truncated_attributes: Vec<String>,
}

impl Span {
    pub fn duration_ns(&self) -> u64 {
        self.end_ns.saturating_sub(self.start_ns)
    }

    pub fn attr_str(&self, key: &str) -> Option<&str> {
        self.attributes.get(key).and_then(AttrValue::as_str)
    }

    pub fn attr_i64(&self, key: &str) -> Option<i64> {
        self.attributes.get(key).and_then(AttrValue::as_i64)
    }

    /// Failed: error status, or an HTTP status code of 500 or more.
    pub fn is_error(&self) -> bool {
        matches!(self.status, Status::Error { .. })
            || self
                .attr_i64(HTTP_RESPONSE_STATUS_CODE)
                .is_some_and(|code| code >= 500)
    }

    /// Rough number of bytes the span holds, for the store's byte bound.
    pub fn approx_size(&self) -> usize {
        let size = |attributes: &Attributes| -> usize {
            attributes
                .iter()
                .map(|(key, value)| key.len() + value.approx_size())
                .sum()
        };
        let events: usize = self
            .events
            .iter()
            .map(|event| {
                32 + event.name.len()
                    + size(&event.attributes)
                    + event
                        .truncated_attributes
                        .iter()
                        .map(String::len)
                        .sum::<usize>()
            })
            .sum();
        128 + self.name.len() + self.service.name.len() + size(&self.attributes) + events
    }
}

#[cfg(test)]
mod tests {
    // Core
    use super::*;

    #[test]
    fn ids_reject_wrong_length_and_all_zeros() {
        assert!(TraceId::from_slice(&[0; 16]).is_none());
        assert!(TraceId::from_slice(&[1; 15]).is_none());
        assert_eq!(
            TraceId::from_slice(&[0xab; 16]).unwrap().to_string(),
            "ab".repeat(16)
        );
        let id = TraceId([0xab; 16]);
        assert_eq!(TraceId::from_hex(&id.to_string()), Some(id));
        assert_eq!(TraceId::from_hex(&"AB".repeat(16)), Some(id));
        for bad in ["ab", &"0".repeat(32), &"zz".repeat(16), &"é".repeat(16)] {
            assert_eq!(TraceId::from_hex(bad), None, "{bad}");
        }
        assert!(SpanId::from_slice(&[0; 8]).is_none());
        assert_eq!(
            SpanId::from_slice(&[1, 2, 3, 4, 5, 6, 7, 8])
                .unwrap()
                .to_string(),
            "0102030405060708"
        );
    }

    #[test]
    fn service_kind_follows_i3() {
        let kind = |language, kind_override| {
            Service::from_resource(Some("s"), language, kind_override).kind
        };
        assert_eq!(kind(None, None), ServiceKind::Service);
        assert_eq!(kind(Some("rust"), None), ServiceKind::Service);
        assert_eq!(kind(Some("webjs"), None), ServiceKind::Frontend);
        assert_eq!(kind(Some("rust"), Some("frontend")), ServiceKind::Frontend);
        assert_eq!(kind(Some("webjs"), Some("service")), ServiceKind::Service);
        assert_eq!(kind(Some("webjs"), Some("bogus")), ServiceKind::Frontend);
    }

    #[test]
    fn missing_service_name_is_unknown_service() {
        assert_eq!(
            Service::from_resource(None, None, None).name,
            "unknown_service"
        );
        assert_eq!(
            Service::from_resource(Some(""), None, None).name,
            "unknown_service"
        );
    }
}
