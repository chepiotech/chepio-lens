//! SSE broadcaster: every event is serialized once and shared; a subscriber that falls behind the bounded buffer
//! gets `resync` instead of the missed events (I9).

// Core
use std::sync::Arc;

use futures_util::stream;
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;
// Domain
use crate::domain::event::LensEvent;
// Ports
use crate::ports::{EventFeed, EventPublisher, EventStream};
// Types
use crate::types::api::{EdgeView, LensEventName, LogEntryView, NodeView, RequestView};
use crate::types::{FeedItem, OutboundEvent};

pub struct SseHub {
    sender: broadcast::Sender<Arc<OutboundEvent>>,
}

impl SseHub {
    pub fn new(buffer_events: usize) -> Self {
        let (sender, _) = broadcast::channel(buffer_events);
        Self { sender }
    }
}

fn outbound(event: &LensEvent) -> OutboundEvent {
    let (name, data) = match event {
        LensEvent::Node(node) => (
            LensEventName::Node,
            serde_json::to_string(&NodeView::from(node)),
        ),
        LensEvent::Edge(edge) => (
            LensEventName::Edge,
            serde_json::to_string(&EdgeView::from(edge)),
        ),
        LensEvent::Request(request) => (
            LensEventName::Request,
            serde_json::to_string(&RequestView::from(request)),
        ),
        LensEvent::Log(entry) => (
            LensEventName::Log,
            serde_json::to_string(&LogEntryView::from(entry)),
        ),
    };
    OutboundEvent {
        name: name.as_str(),
        data: data.unwrap_or_else(|_| "{}".to_owned()),
    }
}

impl EventPublisher for SseHub {
    fn publish(&self, event: &LensEvent) {
        // An error only means nobody is subscribed.
        let _ = self.sender.send(Arc::new(outbound(event)));
    }
}

impl EventFeed for SseHub {
    fn subscribe(&self) -> EventStream {
        let receiver = self.sender.subscribe();
        Box::pin(stream::unfold(receiver, |mut receiver| async move {
            match receiver.recv().await {
                Ok(event) => Some((FeedItem::Event(event), receiver)),
                Err(RecvError::Lagged(_)) => Some((FeedItem::Resync, receiver)),
                Err(RecvError::Closed) => None,
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    // Core
    use futures_util::StreamExt;

    use super::*;
    use crate::domain::node::{Node, NodeKind};

    fn node(id: &str) -> LensEvent {
        LensEvent::Node(Node {
            id: id.into(),
            kind: NodeKind::Service,
            label: id.into(),
            db: None,
            external: None,
            first_seen_ns: 1,
            last_seen_ns: 2,
        })
    }

    #[tokio::test]
    async fn subscribers_get_events_as_json() {
        let hub = SseHub::new(8);
        let mut events = hub.subscribe();
        hub.publish(&node("svc:api"));
        let Some(FeedItem::Event(event)) = events.next().await else {
            panic!("expected an event");
        };
        assert_eq!(event.name, "node");
        assert!(event.data.contains("\"id\":\"svc:api\""), "{}", event.data);
        assert!(
            event.data.contains("\"first_seen\":\"1\""),
            "timestamps are strings: {}",
            event.data
        );
    }

    #[tokio::test]
    async fn a_lagging_subscriber_gets_resync() {
        let hub = SseHub::new(2);
        let mut events = hub.subscribe();
        for i in 0..5 {
            hub.publish(&node(&format!("svc:{i}")));
        }
        assert!(matches!(events.next().await, Some(FeedItem::Resync)));
        assert!(
            matches!(events.next().await, Some(FeedItem::Event(_))),
            "then it continues with recent events"
        );
    }
}
