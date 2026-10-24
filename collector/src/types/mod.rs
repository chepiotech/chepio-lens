//! Types shared across layers: wire formats and the UI API (`docs/architecture/interfaces.md`, section 3).

// Core
use std::sync::Arc;

pub mod api;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OtlpEncoding {
    Protobuf,
    Json,
}

impl OtlpEncoding {
    /// Accepts `application/x-protobuf` and `application/json`, with or without parameters.
    pub fn from_content_type(content_type: &str) -> Option<Self> {
        let media_type = content_type.split(';').next()?.trim().to_ascii_lowercase();
        match media_type.as_str() {
            "application/x-protobuf" => Some(Self::Protobuf),
            "application/json" => Some(Self::Json),
            _ => None,
        }
    }

    pub fn content_type(self) -> &'static str {
        match self {
            Self::Protobuf => "application/x-protobuf",
            Self::Json => "application/json",
        }
    }
}

/// What a UI subscriber receives.
pub enum FeedItem {
    Event(Arc<OutboundEvent>),
    /// The subscriber fell behind and missed events; it must fetch the graph again.
    Resync,
}

/// One SSE message, serialized once and shared by every subscriber.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboundEvent {
    pub name: &'static str,
    pub data: String,
}

#[cfg(test)]
mod tests {
    // Core
    use super::*;

    #[test]
    fn content_types_map_to_encodings() {
        assert_eq!(
            OtlpEncoding::from_content_type("application/x-protobuf"),
            Some(OtlpEncoding::Protobuf)
        );
        assert_eq!(
            OtlpEncoding::from_content_type("Application/JSON; charset=utf-8"),
            Some(OtlpEncoding::Json)
        );
        assert_eq!(OtlpEncoding::from_content_type("text/plain"), None);
    }
}
