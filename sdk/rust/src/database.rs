/// The database the app's sqlx queries go to; names its node on the map (ADR-0008). Never holds credentials.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Database {
    /// `db.system.name`, e.g. `postgresql`.
    pub system: String,
    pub address: Option<String>,
    pub port: Option<u16>,
    /// Database name (`db.namespace`).
    pub namespace: Option<String>,
}

impl Database {
    pub fn new(
        system: &str,
        address: Option<&str>,
        port: Option<u16>,
        namespace: Option<&str>,
    ) -> Self {
        Self {
            system: system.to_owned(),
            address: address.map(str::to_owned),
            port,
            namespace: namespace.map(str::to_owned),
        }
    }

    /// Host, port and database name from `postgres://user:password@host:port/name?options`; user and password are
    /// dropped. Parts that are missing stay `None`.
    pub fn postgres_url(url: &str) -> Self {
        let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
        let rest = rest.split(['?', '#']).next().unwrap_or_default();
        let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
        let host_port = authority
            .rsplit_once('@')
            .map_or(authority, |(_, host)| host);
        let (host, port) = match host_port.rsplit_once(':') {
            Some((host, port)) if !port.contains(']') => (host, port.parse().ok()),
            _ => (host_port, None),
        };
        let non_empty = |text: &str| (!text.is_empty()).then(|| text.to_owned());
        Self {
            system: "postgresql".to_owned(),
            address: non_empty(host),
            port,
            namespace: non_empty(path),
        }
    }
}

#[cfg(test)]
mod tests {
    // Core
    use super::*;

    #[test]
    fn postgres_url_keeps_host_port_and_name_but_no_credentials() {
        let db = Database::postgres_url("postgres://demo:s3cret@db:5432/demo?sslmode=disable");
        assert_eq!(
            db,
            Database::new("postgresql", Some("db"), Some(5432), Some("demo"))
        );
        assert!(!format!("{db:?}").contains("s3cret"));
    }

    #[test]
    fn postgres_url_tolerates_missing_parts() {
        assert_eq!(
            Database::postgres_url("postgresql://localhost/app"),
            Database::new("postgresql", Some("localhost"), None, Some("app"))
        );
        assert_eq!(
            Database::postgres_url("postgres://[::1]:5433"),
            Database::new("postgresql", Some("[::1]"), Some(5433), None)
        );
        assert_eq!(
            Database::postgres_url(""),
            Database::new("postgresql", None, None, None)
        );
    }
}
