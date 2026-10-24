//! One-call OpenTelemetry setup for axum + sqlx backends, reporting to the chepio-lens collector.
//!
//! ```no_run
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! # let database_url = "postgres://demo@localhost/demo";
//! # let router: axum::Router = axum::Router::new();
//! let lens = chepio_lens_sdk::init("demo-api")? // a no-op unless CHEPIO_LENS_ENDPOINT is set
//!     .with_database(chepio_lens_sdk::Database::postgres_url(database_url));
//! lens.install_tracing()?; // or add `lens.tracing_layer()` to your own tracing subscriber
//! let router = router.layer(lens.http_layer());
//! // ... serve, then:
//! lens.shutdown();
//! # Ok(()) }
//! ```

mod database;
mod http;
mod lens;
mod sqlx_events;

pub use database::Database;
pub use http::{HttpLayer, HttpService};
pub use lens::{Config, InitError, Lens, database_events_enabled, init, init_with};
pub use sqlx_events::SqlxEventsLayer;
