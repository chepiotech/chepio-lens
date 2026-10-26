// Core
use chepio_lens_conventions::node_metadata::NodeMetadata;
use std::fmt::Write as _;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum NodeKind {
    Frontend,
    Service,
    Database,
    External,
}

/// A database as client spans describe it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
pub struct DbTarget {
    pub system: String,
    pub address: Option<String>,
    pub port: Option<u16>,
    pub namespace: Option<String>,
}

/// The far end of a client span whose server side never showed up.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
pub struct ExternalTarget {
    pub address: Option<String>,
    pub port: Option<u16>,
}

/// `svc:<service.name>` (I3).
pub fn service_node_id(service: &str) -> String {
    format!("svc:{service}")
}

impl DbTarget {
    /// `db:<db.system.name>:<server.address>:<server.port>/<db.namespace>`, omitting missing parts; the port only
    /// follows an address (I4).
    pub fn node_id(&self) -> String {
        let mut id = format!("db:{}", self.system);
        if let Some(address) = &self.address {
            let _ = write!(id, ":{address}");
            if let Some(port) = self.port {
                let _ = write!(id, ":{port}");
            }
        }
        if let Some(namespace) = &self.namespace {
            let _ = write!(id, "/{namespace}");
        }
        id
    }

    pub fn label(&self) -> String {
        match &self.namespace {
            Some(namespace) => format!("{} {namespace}", self.system),
            None => self.system.clone(),
        }
    }
}

impl ExternalTarget {
    /// `ext:<server.address>:<server.port>` (I5); `ext:<address>` without a port, `ext:unknown` without an address.
    pub fn node_id(&self) -> String {
        format!("ext:{}", self.label())
    }

    pub fn label(&self) -> String {
        match (&self.address, self.port) {
            (Some(address), Some(port)) => format!("{address}:{port}"),
            (Some(address), None) => address.clone(),
            (None, _) => "unknown".to_owned(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub id: String,
    pub kind: NodeKind,
    pub label: String,
    pub db: Option<DbTarget>,
    pub external: Option<ExternalTarget>,
    pub metadata: Option<Arc<NodeMetadata>>,
    pub first_seen_ns: u64,
    pub last_seen_ns: u64,
}

#[cfg(test)]
mod tests {
    // Core
    use super::*;

    fn db(address: Option<&str>, port: Option<u16>, namespace: Option<&str>) -> DbTarget {
        DbTarget {
            system: "postgresql".into(),
            address: address.map(Into::into),
            port,
            namespace: namespace.map(Into::into),
        }
    }

    #[test]
    fn database_node_ids_follow_i4() {
        assert_eq!(
            db(Some("db"), Some(5432), Some("demo")).node_id(),
            "db:postgresql:db:5432/demo"
        );
        assert_eq!(
            db(Some("db"), None, Some("demo")).node_id(),
            "db:postgresql:db/demo"
        );
        assert_eq!(
            db(Some("db"), Some(5432), None).node_id(),
            "db:postgresql:db:5432"
        );
        assert_eq!(
            db(None, Some(5432), Some("demo")).node_id(),
            "db:postgresql/demo"
        );
        assert_eq!(db(None, None, None).node_id(), "db:postgresql");
    }

    #[test]
    fn external_node_ids_follow_i5() {
        let ext = |address: Option<&str>, port| ExternalTarget {
            address: address.map(Into::into),
            port,
        };
        assert_eq!(
            ext(Some("api.example.com"), Some(443)).node_id(),
            "ext:api.example.com:443"
        );
        assert_eq!(
            ext(Some("api.example.com"), None).node_id(),
            "ext:api.example.com"
        );
        assert_eq!(ext(None, Some(443)).node_id(), "ext:unknown");
    }

    #[test]
    fn service_node_id_follows_i3() {
        assert_eq!(service_node_id("demo-api"), "svc:demo-api");
    }
}
