//! I1: the app never fails, blocks or slows down measurably because of chepio-lens, even when the collector is down
//! or hangs.

// Core
use std::net::TcpListener;
use std::thread;
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::routing::get;
use chepio_lens_sdk::{Config, init_with};
use tower::ServiceExt;
use tracing_subscriber::prelude::*;

/// Slowest request allowed: far above a local handler, far below any network timeout.
const BUDGET: Duration = Duration::from_millis(50);

async fn serve_requests(endpoint: String) -> Duration {
    let lens = init_with(Config {
        service_name: "demo-api".into(),
        endpoint: Some(endpoint),
        ..Config::default()
    })
    .unwrap();
    let _subscriber = tracing_subscriber::registry()
        .with(lens.tracing_layer())
        .set_default();
    let app = Router::new()
        .route(
            "/",
            get(|| async {
                tracing::info!(route = "/", "request handled");
                "ok"
            }),
        )
        .layer(lens.http_layer());
    let mut slowest = Duration::ZERO;
    // Enough requests to fill several export batches while the exporter fails or hangs.
    for _ in 0..3_000 {
        let started = Instant::now();
        let response = app
            .clone()
            .oneshot(Request::get("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        slowest = slowest.max(started.elapsed());
    }
    let started = Instant::now();
    lens.shutdown();
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "shutdown took {:?}",
        started.elapsed()
    );
    slowest
}

#[tokio::test]
async fn a_collector_that_is_not_running_does_not_affect_requests() {
    let closed = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    let slowest = serve_requests(format!("http://{closed}")).await;
    assert!(slowest < BUDGET, "slowest request took {slowest:?}");
}

#[tokio::test]
async fn a_collector_that_never_answers_does_not_affect_requests() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    // Accepts connections and never responds.
    thread::spawn(move || {
        let mut held = Vec::new();
        for stream in listener.incoming().flatten() {
            held.push(stream);
        }
    });
    let slowest = serve_requests(format!("http://{addr}")).await;
    assert!(slowest < BUDGET, "slowest request took {slowest:?}");
}
