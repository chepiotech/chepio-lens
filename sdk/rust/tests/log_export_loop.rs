//! Exporting a log must not generate an endless stream of transport logs.
// Core
use axum::{Router, routing::post};
use chepio_lens_sdk::{Config, init_with};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;
use tracing::instrument::WithSubscriber;
use tracing_subscriber::prelude::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exporter_transport_diagnostics_do_not_generate_more_exports() {
    let exports = Arc::new(AtomicUsize::new(0));
    let observed = exports.clone();
    let app = Router::new().route(
        "/v1/logs",
        post(move || {
            let observed = observed.clone();
            async move {
                observed.fetch_add(1, Ordering::SeqCst);
                "{}"
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    // The fixture collector runs in this process; its accept logs are not application events.
    let server = tokio::spawn(
        async { axum::serve(listener, app).await.unwrap() }
            .with_subscriber(tracing::subscriber::NoSubscriber::default()),
    );
    let lens = init_with(Config {
        service_name: "loop-test".into(),
        endpoint: Some(endpoint),
        ..Config::default()
    })
    .unwrap();
    // Global so events on reqwest's own worker thread reach the layer too. This integration binary has one test.
    tracing_subscriber::registry()
        .with(lens.tracing_layer())
        .init();
    tracing::info!(count = 1, "application work completed");
    tokio::time::timeout(Duration::from_secs(5), async {
        while exports.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(1_600)).await;
    assert_eq!(
        exports.load(Ordering::SeqCst),
        1,
        "idle transport generated new log exports"
    );
    lens.shutdown();
    server.abort();
}
