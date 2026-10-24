// Core
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};

/// Most notes one list call returns, newest first; keeps `fetch_all` bounded.
pub const LIST_LIMIT: i64 = 100;

/// Same bound as the `notes.text` check constraint; both count characters, not bytes.
const MAX_TEXT_CHARS: usize = 1000;

#[derive(Debug, Serialize, FromRow)]
pub struct Note {
    pub id: i64,
    pub text: String,
}

#[derive(Debug, Deserialize)]
pub struct NoteInput {
    pub text: String,
}

impl NoteInput {
    /// The trimmed text, if it has 1 to 1000 characters.
    pub fn validated_text(&self) -> Option<&str> {
        let text = self.text.trim();
        (1..=MAX_TEXT_CHARS)
            .contains(&text.chars().count())
            .then_some(text)
    }
}

pub async fn list(pool: &PgPool) -> sqlx::Result<Vec<Note>> {
    sqlx::query_as("SELECT id, text FROM notes ORDER BY id DESC LIMIT $1")
        .bind(LIST_LIMIT)
        .fetch_all(pool)
        .await
}

pub async fn get(pool: &PgPool, id: i64) -> sqlx::Result<Option<Note>> {
    sqlx::query_as("SELECT id, text FROM notes WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
}

pub async fn create(pool: &PgPool, text: &str) -> sqlx::Result<Note> {
    sqlx::query_as("INSERT INTO notes (text) VALUES ($1) RETURNING id, text")
        .bind(text)
        .fetch_one(pool)
        .await
}

pub async fn update(pool: &PgPool, id: i64, text: &str) -> sqlx::Result<Option<Note>> {
    sqlx::query_as("UPDATE notes SET text = $2 WHERE id = $1 RETURNING id, text")
        .bind(id)
        .bind(text)
        .fetch_optional(pool)
        .await
}

/// Returns whether a note was deleted.
pub async fn delete(pool: &PgPool, id: i64) -> sqlx::Result<bool> {
    let result = sqlx::query("DELETE FROM notes WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() == 1)
}
