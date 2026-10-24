//! Demo backend that chepio-lens instruments: notes CRUD, a login with a password field, a slow and a failing
//! endpoint.

mod error;
mod handlers;
mod notes;

// Core
use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post};
use sqlx::PgPool;
use sqlx::migrate::Migrator;

/// Migrations from `migrations/`, embedded at compile time.
pub static MIGRATOR: Migrator = sqlx::migrate!();

/// Largest accepted request body; a note holds at most 1000 characters.
const BODY_LIMIT_BYTES: usize = 64 * 1024;

pub fn app(pool: PgPool) -> Router {
    Router::new()
        .route("/api/health", get(handlers::health))
        .route(
            "/api/notes",
            get(handlers::list_notes).post(handlers::create_note),
        )
        .route(
            "/api/notes/{id}",
            get(handlers::get_note)
                .put(handlers::update_note)
                .delete(handlers::delete_note),
        )
        .route("/api/login", post(handlers::login))
        .route("/api/slow", get(handlers::slow))
        .route("/api/fail", get(handlers::fail))
        .layer(DefaultBodyLimit::max(BODY_LIMIT_BYTES))
        .with_state(pool)
}
