//! Optional, bounded resource metadata for map cards. No discovery, I/O or user payloads.

// Core
use serde_json::{Value, json};

pub const MAX_METADATA_BYTES: usize = 16_384;
pub const MAX_TECHNOLOGIES: usize = 16;
pub const MAX_PAGES: usize = 32;
pub const MAX_MICROFRONTENDS: usize = 8;

#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub struct NodeMetadata {
    pub technologies: Vec<String>,
    pub pages: Vec<String>,
    pub microfrontends: Vec<Microfrontend>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub struct Microfrontend {
    pub name: String,
    pub framework: String,
    pub pages: Vec<String>,
}

impl NodeMetadata {
    /// Invalid or oversized metadata is ignored without rejecting the accompanying telemetry.
    pub fn from_json(text: &str) -> Option<Self> {
        if text.len() > MAX_METADATA_BYTES {
            return None;
        }
        let value: Value = serde_json::from_str(text).ok()?;
        value.as_object()?;
        let mut remaining = MAX_PAGES;
        let technologies = strings(value.get("technologies"), MAX_TECHNOLOGIES, technology);
        let pages = pages(value.get("pages"), &mut remaining);
        let mut microfrontends = Vec::new();
        if let Some(items) = value.get("microfrontends").and_then(Value::as_array) {
            for item in items.iter().take(MAX_MICROFRONTENDS) {
                let Some(name) = item
                    .get("name")
                    .and_then(Value::as_str)
                    .and_then(|s| label(s, 64))
                else {
                    continue;
                };
                let Some(framework) = item
                    .get("framework")
                    .and_then(Value::as_str)
                    .and_then(technology)
                else {
                    continue;
                };
                if !is_frontend_framework(&framework)
                    || microfrontends
                        .iter()
                        .any(|m: &Microfrontend| m.name == name)
                {
                    continue;
                }
                microfrontends.push(Microfrontend {
                    name,
                    framework,
                    pages: self::pages(item.get("pages"), &mut remaining),
                });
            }
        }
        Some(Self {
            technologies,
            pages,
            microfrontends,
        })
    }

    /// Applies the same limits to typed SDK settings before putting anything on the wire.
    pub fn normalized(&self) -> Self {
        let mut remaining = MAX_PAGES;
        let technologies = unique(
            self.technologies
                .iter()
                .take(MAX_TECHNOLOGIES)
                .filter_map(|s| technology(s)),
        );
        let pages = normalize_pages(self.pages.iter().map(String::as_str), &mut remaining);
        let mut microfrontends = Vec::new();
        for item in self.microfrontends.iter().take(MAX_MICROFRONTENDS) {
            let Some(name) = label(&item.name, 64) else {
                continue;
            };
            let Some(framework) = technology(&item.framework) else {
                continue;
            };
            if !is_frontend_framework(&framework)
                || microfrontends
                    .iter()
                    .any(|m: &Microfrontend| m.name == name)
            {
                continue;
            }
            microfrontends.push(Microfrontend {
                name,
                framework,
                pages: normalize_pages(item.pages.iter().map(String::as_str), &mut remaining),
            });
        }
        Self {
            technologies,
            pages,
            microfrontends,
        }
    }

    pub fn to_json(&self) -> String {
        let value = self.normalized();
        json!({
            "technologies": value.technologies,
            "pages": value.pages,
            "microfrontends": value.microfrontends.iter().map(|item| json!({ "name": item.name, "framework": item.framework, "pages": item.pages })).collect::<Vec<_>>()
        }).to_string()
    }

    pub fn approx_size(&self) -> usize {
        96 + self
            .technologies
            .iter()
            .chain(&self.pages)
            .map(|s| 24 + s.len())
            .sum::<usize>()
            + self
                .microfrontends
                .iter()
                .map(|m| {
                    96 + m.name.len()
                        + m.framework.len()
                        + m.pages.iter().map(|s| 24 + s.len()).sum::<usize>()
                })
                .sum::<usize>()
    }
}

pub fn is_frontend_framework(value: &str) -> bool {
    matches!(
        value,
        "react" | "vue" | "angular" | "svelte" | "solid" | "preact" | "nextjs" | "nuxt" | "qwik"
    )
}

fn label(value: &str, limit: usize) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().any(char::is_control) {
        return None;
    }
    let mut end = value.len().min(limit);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    Some(value[..end].to_owned())
}

fn technology(value: &str) -> Option<String> {
    let value = label(value, 48)?.to_ascii_lowercase();
    if !value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b" .+#_-".contains(&b))
    {
        return None;
    }
    Some(
        match value.as_str() {
            "vuejs" => "vue",
            "reactjs" => "react",
            "next.js" => "nextjs",
            "nuxtjs" => "nuxt",
            _ => &value,
        }
        .to_owned(),
    )
}

fn unique(values: impl Iterator<Item = String>) -> Vec<String> {
    let mut result = Vec::new();
    for value in values {
        if !result.contains(&value) {
            result.push(value);
        }
    }
    result
}

fn strings(
    value: Option<&Value>,
    limit: usize,
    normalize: fn(&str) -> Option<String>,
) -> Vec<String> {
    unique(
        value
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(limit)
            .filter_map(Value::as_str)
            .filter_map(normalize),
    )
}

fn pages(value: Option<&Value>, remaining: &mut usize) -> Vec<String> {
    normalize_pages(
        value
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str),
        remaining,
    )
}

fn normalize_pages<'a>(
    values: impl Iterator<Item = &'a str>,
    remaining: &mut usize,
) -> Vec<String> {
    let result = unique(values.take(*remaining).filter_map(|value| {
        let value = value.split(['?', '#']).next()?.trim();
        if !value.starts_with('/') || value.starts_with("//") {
            return None;
        }
        label(value, 160)
    }));
    *remaining -= result.len();
    result
}

#[cfg(test)]
mod tests {
    // Core
    use super::*;

    #[test]
    fn shared_metadata_vectors() {
        let vectors: Value =
            serde_json::from_str(include_str!("../testdata/node_metadata.json")).unwrap();
        for case in vectors.as_array().unwrap() {
            let parsed = NodeMetadata::from_json(&case["input"].to_string()).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&parsed.to_json()).unwrap(),
                case["expected"],
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn bounds_and_invalid_metadata_never_escape_to_the_wire() {
        assert!(NodeMetadata::from_json("not json").is_none());
        assert!(NodeMetadata::from_json("[]").is_none());
        assert!(NodeMetadata::from_json(&" ".repeat(MAX_METADATA_BYTES + 1)).is_none());
        let metadata = NodeMetadata {
            technologies: (0..100).map(|i| format!("tech-{i}")).collect(),
            pages: (0..100).map(|i| format!("/page/{i}?secret=fake")).collect(),
            microfrontends: vec![
                Microfrontend {
                    name: "a".repeat(200),
                    framework: "react".into(),
                    pages: vec!["/test".into()]
                };
                100
            ],
        }
        .normalized();
        assert_eq!(metadata.technologies.len(), MAX_TECHNOLOGIES);
        assert_eq!(metadata.pages.len(), MAX_PAGES);
        assert!(metadata.microfrontends.len() <= MAX_MICROFRONTENDS);
        assert!(metadata.microfrontends.iter().all(|m| m.pages.is_empty()));
        assert!(!metadata.to_json().contains("secret"));
        assert!(metadata.to_json().len() <= MAX_METADATA_BYTES);
    }
}
