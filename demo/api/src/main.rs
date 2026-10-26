// Core
use std::env;
use std::error::Error;
use std::net::SocketAddr;
use std::str::FromStr;
use std::time::Duration;

use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use tokio::net::TcpListener;
use tokio::signal;
// Handlers
use demo_api::{MIGRATOR, app};

// Loopback by default. The container sets DEMO_API_ADDR=0.0.0.0:8080 and compose publishes it on 127.0.0.1 only.
const DEFAULT_ADDR: &str = "127.0.0.1:8080";
const DB_MAX_CONNECTIONS: u32 = 5;
const DB_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(3);
// Per-statement budget; every demo query is far below it.
const DB_STATEMENT_TIMEOUT: &str = "5s";

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let database_url = env::var("DATABASE_URL").map_err(|_| "DATABASE_URL is not set")?;
    let addr: SocketAddr = env::var("DEMO_API_ADDR")
        .unwrap_or_else(|_| DEFAULT_ADDR.to_owned())
        .parse()?;

    // Before the pool, so the startup migrations show up too.
    #[cfg(feature = "lens")]
    let lens = {
        let mut config = chepio_lens_sdk::Config::from_env("demo-api", |name| env::var(name).ok());
        config
            .node
            .get_or_insert_with(|| chepio_lens_sdk::NodeMetadata {
                technologies: ["rust", "axum", "sqlx", "tokio"]
                    .map(str::to_owned)
                    .to_vec(),
                ..Default::default()
            });
        let lens = chepio_lens_sdk::init_with(config)?
            .with_database(chepio_lens_sdk::Database::postgres_url(&database_url));
        lens.install_tracing()?;
        lens
    };

    let options = PgConnectOptions::from_str(&database_url)?
        .options([("statement_timeout", DB_STATEMENT_TIMEOUT)]);
    let pool = PgPoolOptions::new()
        .max_connections(DB_MAX_CONNECTIONS)
        .acquire_timeout(DB_ACQUIRE_TIMEOUT)
        .connect_with(options)
        .await?;
    MIGRATOR.run(&pool).await?;

    let router = app(pool);
    #[cfg(feature = "lens")]
    let router = router.layer(lens.http_layer());

    let listener = TcpListener::bind(addr).await?;
    println!("demo-api listening on http://{addr}");
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    #[cfg(feature = "lens")]
    lens.shutdown();
    Ok(())
}

/// Resolves on Ctrl+C or SIGTERM (`docker compose stop`).
async fn shutdown_signal() {
    let ctrl_c = async {
        // If the handler cannot be registered, keep running rather than shut down at once.
        if signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match signal::unix::signal(signal::unix::SignalKind::terminate()) {
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
