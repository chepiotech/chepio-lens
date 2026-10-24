// Core
use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug)]
pub enum ApiError {
    NotFound,
    InvalidText,
    Unauthorized,
    Database(sqlx::Error),
}

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::NotFound => (StatusCode::NOT_FOUND, "note not found"),
            Self::InvalidText => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "text must be 1 to 1000 characters",
            ),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "invalid credentials"),
            Self::Database(error) => {
                eprintln!("database error: {error}");
                (StatusCode::INTERNAL_SERVER_ERROR, "database error")
            }
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}
