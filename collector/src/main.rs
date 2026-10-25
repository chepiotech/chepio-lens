// Core
use std::future::IntoFuture;
use std::io::IsTerminal;
use std::process::ExitCode;

use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::time::{interval, timeout};
use tracing::{error, info, warn};
// Handlers
use chepio_lens_collector::app::{Config, Limits, build};
use chepio_lens_collector::handlers::{otlp_router, ui_router};
// Consts
use chepio_lens_collector::consts::{EXPIRY_TICK, SHUTDOWN_GRACE};

#[tokio::main]
async fn main() -> ExitCode {
    // Structured logs to stderr; payload values are never logged (I10).
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(std::io::stderr().is_terminal())
        .with_target(false)
        .init();

    let config = match Config::from_env(|name| std::env::var(name).ok()) {
        Ok(config) => config,
        Err(message) => {
            error!("invalid configuration: {message}");
            return ExitCode::FAILURE;
        }
    };
    let state = build(&config.redact_keys, &config.cors_origins, Limits::default());

    let bind = |addr| async move {
        TcpListener::bind(addr)
            .await
            .map_err(|error| error!("cannot listen on {addr}: {error}"))
    };
    let (Ok(otlp_listener), Ok(ui_listener)) =
        (bind(config.otlp_addr).await, bind(config.ui_addr).await)
    else {
        return ExitCode::FAILURE;
    };
    info!(
        version = env!("CARGO_PKG_VERSION"),
        otlp = %config.otlp_addr,
        ui = %config.ui_addr,
        cors_origins = %config.cors_origins.join(","),
        "chepio-lens collector listening"
    );

    let ticker = state.clone();
    tokio::spawn(async move {
        let mut tick = interval(EXPIRY_TICK);
        loop {
            tick.tick().await;
            ticker.ingest.tick(ticker.clock.now());
        }
    });

    let (stop, stopped) = watch::channel(());
    let until_stopped = |mut stopped: watch::Receiver<()>| async move {
        let _ = stopped.changed().await;
    };
    let otlp = axum::serve(otlp_listener, otlp_router(state.clone()))
        .with_graceful_shutdown(until_stopped(stopped.clone()));
    let ui =
        axum::serve(ui_listener, ui_router(state)).with_graceful_shutdown(until_stopped(stopped));
    let servers = tokio::spawn(async move { tokio::join!(otlp.into_future(), ui.into_future()) });

    shutdown_signal().await;
    info!("shutting down");
    let _ = stop.send(());
    // Open SSE streams never finish on their own; give in-flight ingest the grace period and exit.
    if timeout(SHUTDOWN_GRACE, servers).await.is_err() {
        warn!("connections still open after {SHUTDOWN_GRACE:?}; exiting");
    }
    ExitCode::SUCCESS
}

async fn shutdown_signal() {
    let ctrl_c = async {
        // If the handler cannot be registered, keep running rather than shut down at once.
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sigterm) => {
                sigterm.recv().await;
            }
            Err(_) => std::future::pending().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
}
