// Core
use std::hash::{BuildHasher, RandomState};
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgPool;
// Repositories
use crate::notes::{self, Note, NoteInput};
// Types
use crate::error::ApiError;

// Fake credentials. The password and the token are what chepio-lens must redact.
const DEMO_USERNAME: &str = "demo";
const DEMO_PASSWORD: &str = "demo-password";
const DEMO_TOKEN: &str = "demo-session-token";

const SLOW_MIN_MS: u64 = 300;
const SLOW_MAX_MS: u64 = 800;

pub async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

pub async fn list_notes(State(pool): State<PgPool>) -> Result<Json<Vec<Note>>, ApiError> {
    Ok(Json(notes::list(&pool).await?))
}

pub async fn get_note(
    State(pool): State<PgPool>,
    Path(id): Path<i64>,
) -> Result<Json<Note>, ApiError> {
    notes::get(&pool, id)
        .await?
        .map(Json)
        .ok_or(ApiError::NotFound)
}

pub async fn create_note(
    State(pool): State<PgPool>,
    Json(input): Json<NoteInput>,
) -> Result<(StatusCode, Json<Note>), ApiError> {
    let text = input.validated_text().ok_or(ApiError::InvalidText)?;
    Ok((StatusCode::CREATED, Json(notes::create(&pool, text).await?)))
}

pub async fn update_note(
    State(pool): State<PgPool>,
    Path(id): Path<i64>,
    Json(input): Json<NoteInput>,
) -> Result<Json<Note>, ApiError> {
    let text = input.validated_text().ok_or(ApiError::InvalidText)?;
    notes::update(&pool, id, text)
        .await?
        .map(Json)
        .ok_or(ApiError::NotFound)
}

pub async fn delete_note(
    State(pool): State<PgPool>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    match notes::delete(&pool, id).await? {
        true => Ok(StatusCode::NO_CONTENT),
        false => Err(ApiError::NotFound),
    }
}

#[derive(Deserialize)]
pub struct LoginRequest {
    username: String,
    password: String,
}

#[derive(Serialize)]
pub struct LoginResponse {
    token: &'static str,
}

pub async fn login(Json(request): Json<LoginRequest>) -> Result<Json<LoginResponse>, ApiError> {
    if request.username == DEMO_USERNAME && request.password == DEMO_PASSWORD {
        Ok(Json(LoginResponse { token: DEMO_TOKEN }))
    } else {
        Err(ApiError::Unauthorized)
    }
}

#[derive(Serialize)]
pub struct SlowResponse {
    slept_ms: u64,
}

pub async fn slow() -> Json<SlowResponse> {
    // A freshly keyed RandomState gives enough randomness for demo jitter without a dependency.
    let slept_ms = SLOW_MIN_MS + RandomState::new().hash_one(()) % (SLOW_MAX_MS - SLOW_MIN_MS + 1);
    tokio::time::sleep(Duration::from_millis(slept_ms)).await;
    Json(SlowResponse { slept_ms })
}

/// Queries a table that does not exist, so the request always ends in a database error and a 500.
pub async fn fail(State(pool): State<PgPool>) -> Result<StatusCode, ApiError> {
    sqlx::query("SELECT id FROM missing_table")
        .execute(&pool)
        .await?;
    Ok(StatusCode::OK)
}
