//! Redaction defaults and rules from `docs/architecture/security.md`. Applied by the SDKs before export and again by
//! the collector on ingest (I2). The TypeScript copy in the web SDK must pass `testdata/redaction.json` too.

// Core
use serde_json::Value;

/// What a masked value is replaced with.
pub const REDACTED: &str = "[REDACTED]";

/// Header names masked by default (exact, case-insensitive).
pub const DEFAULT_HEADER_NAMES: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-auth-token",
    "x-csrf-token",
];

/// JSON keys, form fields and query parameters are masked when their name contains one of these (case-insensitive).
pub const DEFAULT_KEY_PATTERNS: &[&str] = &[
    "password",
    "passwd",
    "secret",
    "token",
    "apikey",
    "api_key",
    "authorization",
    "cookie",
    "session",
    "credential",
    "private_key",
    "card_number",
    "cvv",
    "iban",
];

/// Text after redaction and how many values were masked. Values already equal to [`REDACTED`] are not counted
/// again, so a second pass (SDK, then collector) does not inflate the count.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redacted {
    pub text: String,
    pub count: usize,
}

#[derive(Debug, Clone)]
pub struct Redactor {
    header_names: Vec<String>,
    key_patterns: Vec<String>,
}

impl Default for Redactor {
    fn default() -> Self {
        Self::new(&[])
    }
}

impl Redactor {
    /// The defaults plus `extra_keys` (`CHEPIO_LENS_REDACT_KEYS`), which apply both as header names and as key
    /// patterns. Configuration can add keys, never remove defaults.
    pub fn new(extra_keys: &[&str]) -> Self {
        let extra = extra_keys
            .iter()
            .map(|key| key.trim().to_ascii_lowercase())
            .filter(|key| !key.is_empty());
        let header_names = DEFAULT_HEADER_NAMES
            .iter()
            .map(|name| (*name).to_owned())
            .chain(extra.clone())
            .collect();
        let key_patterns = DEFAULT_KEY_PATTERNS
            .iter()
            .map(|pattern| (*pattern).to_owned())
            .chain(extra)
            .collect();
        Self {
            header_names,
            key_patterns,
        }
    }

    pub fn is_sensitive_header(&self, name: &str) -> bool {
        let name = name.to_ascii_lowercase();
        self.header_names.contains(&name)
    }

    pub fn is_sensitive_key(&self, key: &str) -> bool {
        let key = key.to_ascii_lowercase();
        self.key_patterns
            .iter()
            .any(|pattern| key.contains(pattern.as_str()))
    }

    /// Masks a header value when the header name is sensitive.
    pub fn redact_header(&self, name: &str, value: &str) -> Redacted {
        if self.is_sensitive_header(name) && value != REDACTED {
            Redacted {
                text: REDACTED.to_owned(),
                count: 1,
            }
        } else {
            unchanged(value)
        }
    }

    /// Masks the values of sensitive keys at any depth, keeping key order. `None` when `body` is not valid JSON:
    /// such a body is kept as text without key-based masking.
    pub fn redact_json(&self, body: &str) -> Option<Redacted> {
        let mut value: Value = serde_json::from_str(body).ok()?;
        let count = self.mask_json(&mut value);
        let text = match count {
            0 => body.to_owned(),
            _ => serde_json::to_string(&value).ok()?,
        };
        Some(Redacted { text, count })
    }

    fn mask_json(&self, value: &mut Value) -> usize {
        match value {
            Value::Object(map) => map
                .iter_mut()
                .map(|(key, value)| match self.is_sensitive_key(key) {
                    true if value.as_str() == Some(REDACTED) => 0,
                    true => {
                        *value = Value::String(REDACTED.to_owned());
                        1
                    }
                    false => self.mask_json(value),
                })
                .sum(),
            Value::Array(items) => items.iter_mut().map(|item| self.mask_json(item)).sum(),
            _ => 0,
        }
    }

    /// Masks sensitive fields of an `application/x-www-form-urlencoded` body or a URL query string, keeping order and
    /// separators. Field names are percent-decoded before matching.
    pub fn redact_form(&self, form: &str) -> Redacted {
        let mut count = 0;
        let text = form
            .split('&')
            .map(|pair| match pair.split_once('=') {
                Some((key, value))
                    if value != REDACTED && self.is_sensitive_key(&percent_decode(key)) =>
                {
                    count += 1;
                    format!("{key}={REDACTED}")
                }
                _ => pair.to_owned(),
            })
            .collect::<Vec<_>>()
            .join("&");
        Redacted { text, count }
    }

    /// Masks sensitive query parameters of a URL; the path and the fragment are kept.
    pub fn redact_url(&self, url: &str) -> Redacted {
        let Some((base, rest)) = url.split_once('?') else {
            return unchanged(url);
        };
        let (query, fragment) = match rest.split_once('#') {
            Some((query, fragment)) => (query, Some(fragment)),
            None => (rest, None),
        };
        let query = self.redact_form(query);
        let text = match fragment {
            Some(fragment) => format!("{base}?{}#{fragment}", query.text),
            None => format!("{base}?{}", query.text),
        };
        Redacted {
            text,
            count: query.count,
        }
    }
}

fn unchanged(text: &str) -> Redacted {
    Redacted {
        text: text.to_owned(),
        count: 0,
    }
}

/// Decodes `%XX` escapes and `+` (space); invalid escapes stay as they are.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => decoded.push(b' '),
            b'%' if i + 2 < bytes.len() => match (hex_digit(bytes[i + 1]), hex_digit(bytes[i + 2]))
            {
                (Some(high), Some(low)) => {
                    decoded.push(high << 4 | low);
                    i += 2;
                }
                _ => decoded.push(b'%'),
            },
            byte => decoded.push(byte),
        }
        i += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn hex_digit(byte: u8) -> Option<u8> {
    char::from(byte).to_digit(16).map(|digit| digit as u8)
}

#[cfg(test)]
mod tests {
    // Core
    use serde_json::Value;

    use super::*;

    const VECTORS: &str = include_str!("../testdata/redaction.json");

    /// Runs the vectors shared with the web SDK (`testdata/redaction.json`).
    #[test]
    fn shared_vectors_pass() {
        let vectors: Value = serde_json::from_str(VECTORS).unwrap();
        let cases = vectors["cases"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let extra: Vec<&str> = case["extra_keys"]
                .as_array()
                .map(|keys| keys.iter().map(|key| key.as_str().unwrap()).collect())
                .unwrap_or_default();
            let redactor = Redactor::new(&extra);
            let input = case["input"].as_str().unwrap();
            let actual = match case["kind"].as_str().unwrap() {
                "header" => Some(redactor.redact_header(case["header"].as_str().unwrap(), input)),
                "json" => redactor.redact_json(input),
                "form" => Some(redactor.redact_form(input)),
                "url" => Some(redactor.redact_url(input)),
                kind => panic!("{name}: unknown kind {kind}"),
            };
            let expected = case["expected"].as_str().map(|text| Redacted {
                text: text.to_owned(),
                count: case["count"].as_u64().unwrap() as usize,
            });
            assert_eq!(actual, expected, "case: {name}");
        }
    }

    #[test]
    fn percent_decode_handles_escapes_plus_and_invalid_input() {
        assert_eq!(percent_decode("pass%77ord"), "password");
        assert_eq!(percent_decode("a+b"), "a b");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}
