//! `install_tracing` exports app logs at `INFO` and above, keeps the `sqlx::query` events that become database spans,
//! and leaves libraries' `DEBUG` and `TRACE` events out.
// Core
use axum::body::Bytes;
use axum::{Router, routing::post};
use chepio_lens_sdk::{Config, database_events_enabled, init_with};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing::instrument::WithSubscriber;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn installed_subscriber_exports_info_and_above_and_keeps_query_events() {
    let bodies = Arc::new(Mutex::new(Vec::<u8>::new()));
    let received = bodies.clone();
    let app = Router::new().route(
        "/v1/logs",
        post(move |body: Bytes| {
            let received = received.clone();
            async move {
                received.lock().unwrap().extend_from_slice(&body);
                "{}"
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    // The fixture collector runs in this process; its own events are not the app's.
    let server = tokio::spawn(
        async { axum::serve(listener, app).await.unwrap() }
            .with_subscriber(tracing::subscriber::NoSubscriber::default()),
    );
    let lens = init_with(Config {
        service_name: "levels-test".into(),
        endpoint: Some(endpoint),
        ..Config::default()
    })
    .unwrap();
    // Global: this integration binary has one test.
    lens.install_tracing().unwrap();

    assert!(
        database_events_enabled(),
        "sqlx::query at DEBUG must reach the layer"
    );
    tracing::trace!(target: "axum::serve", "connection 127.0.0.1:1 accepted");
    tracing::debug!(target: "tower::buffer", "library detail");
    tracing::debug!("app debug detail");
    tracing::info!("app work completed");
    tracing::warn!(target: "some_dependency", "dependency warning");
    lens.shutdown();
    tokio::time::sleep(Duration::from_millis(100)).await;

    let exported = String::from_utf8_lossy(&bodies.lock().unwrap()).into_owned();
    assert!(exported.contains("app work completed"), "INFO is exported");
    assert!(
        exported.contains("dependency warning"),
        "WARN from any target is exported"
    );
    for left_out in [
        "connection 127.0.0.1:1 accepted",
        "library detail",
        "app debug detail",
    ] {
        assert!(
            !exported.contains(left_out),
            "{left_out:?} is below INFO and must stay out"
        );
    }
    server.abort();
}
