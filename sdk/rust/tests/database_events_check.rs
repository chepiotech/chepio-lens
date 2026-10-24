//! The setup check from ADR-0008: a global INFO filter hides sqlx query events. Own test binary, so no other test's
//! subscriber is involved.

// Core
use chepio_lens_sdk::database_events_enabled;
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::prelude::*;

#[test]
fn a_global_info_filter_turns_database_events_off() {
    {
        let _info = tracing::subscriber::set_default(
            tracing_subscriber::registry().with(LevelFilter::INFO),
        );
        assert!(!database_events_enabled());
    }
    {
        let _debug = tracing::subscriber::set_default(
            tracing_subscriber::registry().with(LevelFilter::DEBUG),
        );
        assert!(database_events_enabled());
    }
}
