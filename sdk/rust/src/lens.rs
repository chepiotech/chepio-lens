// Core
use std::sync::Arc;
use std::time::Duration;
use std::{env, fmt, thread};

use opentelemetry::KeyValue;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::{Protocol, SpanExporter, WithExportConfig};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::trace::{
    BatchConfigBuilder, BatchSpanProcessor, SdkTracer, SdkTracerProvider,
    SpanExporter as SpanExporterTrait,
};
use tracing_subscriber::prelude::*;
// Domain
use crate::capture::{CaptureConfig, DEFAULT_BODY_LIMIT};
use crate::database::Database;
use crate::http::HttpLayer;
use crate::sqlx_events::SqlxEventsLayer;
use chepio_lens_conventions::redaction::Redactor;
// Consts
use chepio_lens_conventions::keys::LENS_SDK_VERSION;

/// Every 500 ms instead of OpenTelemetry's 5 s, so the map stays live (`docs/architecture/runtime.md`).
const EXPORT_INTERVAL: Duration = Duration::from_millis(500);
const EXPORT_BATCH_SPANS: usize = 512;
/// On overflow new spans are dropped; the app is not affected (I1, I9).
const EXPORT_QUEUE_SPANS: usize = 2_048;
/// No retries are added on top; a batch that does not make it in time is dropped.
const EXPORT_TIMEOUT: Duration = Duration::from_secs(2);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
const ENDPOINT_VAR: &str = "CHEPIO_LENS_ENDPOINT";
const CAPTURE_BODIES_VAR: &str = "CHEPIO_LENS_CAPTURE_BODIES";
const BODY_LIMIT_VAR: &str = "CHEPIO_LENS_BODY_LIMIT";
const REDACT_KEYS_VAR: &str = "CHEPIO_LENS_REDACT_KEYS";

/// SDK settings; [`init`] reads them from the environment (`docs/architecture/interfaces.md`, Configuration).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub service_name: String,
    /// Collector OTLP base URL, e.g. `http://localhost:4318`. `None` turns the SDK into a no-op.
    pub endpoint: Option<String>,
    /// Capture request and response bodies of text content types; headers are always captured.
    pub capture_bodies: bool,
    /// Most bytes of a redacted body exported.
    pub body_limit: usize,
    /// Keys masked in addition to the defaults; they never replace them.
    pub redact_keys: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            service_name: "unknown_service".to_owned(),
            endpoint: None,
            capture_bodies: true,
            body_limit: DEFAULT_BODY_LIMIT,
            redact_keys: Vec::new(),
        }
    }
}

impl Config {
    /// Settings from `CHEPIO_LENS_*` variables read through `var`. An invalid value prints a warning and keeps the
    /// default: a typo in a chepio-lens variable must not stop the app (I1).
    pub fn from_env(service_name: &str, var: impl Fn(&str) -> Option<String>) -> Self {
        let defaults = Self::default();
        let capture_bodies = match var(CAPTURE_BODIES_VAR).as_deref().map(str::trim) {
            None | Some("") => defaults.capture_bodies,
            Some("true" | "1") => true,
            Some("false" | "0") => false,
            Some(other) => {
                eprintln!(
                    "chepio-lens: {CAPTURE_BODIES_VAR}={other:?} is not true or false; bodies are captured"
                );
                defaults.capture_bodies
            }
        };
        let body_limit = match var(BODY_LIMIT_VAR) {
            None => defaults.body_limit,
            Some(value) => value.trim().parse().unwrap_or_else(|_| {
                eprintln!(
                    "chepio-lens: {BODY_LIMIT_VAR}={value:?} is not a byte count; using {}",
                    defaults.body_limit
                );
                defaults.body_limit
            }),
        };
        Self {
            service_name: service_name.to_owned(),
            endpoint: var(ENDPOINT_VAR).filter(|endpoint| !endpoint.trim().is_empty()),
            capture_bodies,
            body_limit,
            redact_keys: var(REDACT_KEYS_VAR)
                .map(|keys| {
                    keys.split(',')
                        .map(str::trim)
                        .filter(|key| !key.is_empty())
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
        }
    }

    fn capture(&self) -> Arc<CaptureConfig> {
        let keys: Vec<&str> = self.redact_keys.iter().map(String::as_str).collect();
        Arc::new(CaptureConfig {
            bodies: self.capture_bodies,
            body_limit: self.body_limit,
            redactor: Redactor::new(&keys),
        })
    }
}

#[derive(Debug)]
pub struct InitError(String);

impl fmt::Display for InitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "chepio-lens: {}", self.0)
    }
}

impl std::error::Error for InitError {}

/// Handle to the SDK. Cheap to clone; every method is a no-op when no endpoint is configured.
#[derive(Clone)]
pub struct Lens {
    inner: Option<Arc<Inner>>,
}

#[derive(Clone)]
struct Inner {
    provider: SdkTracerProvider,
    tracer: SdkTracer,
    capture: Arc<CaptureConfig>,
    database: Option<Database>,
}

/// Reads `CHEPIO_LENS_ENDPOINT` and the other `CHEPIO_LENS_*` settings; without an endpoint the SDK does nothing.
pub fn init(service_name: &str) -> Result<Lens, InitError> {
    init_with(Config::from_env(service_name, |name| env::var(name).ok()))
}

pub fn init_with(config: Config) -> Result<Lens, InitError> {
    let Some(endpoint) = config.endpoint.clone() else {
        return Ok(Lens { inner: None });
    };
    let exporter = SpanExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(format!("{}/v1/traces", endpoint.trim_end_matches('/')))
        .with_timeout(EXPORT_TIMEOUT)
        .build()
        .map_err(|error| InitError(format!("cannot create the OTLP exporter: {error}")))?;
    let batch = BatchConfigBuilder::default()
        .with_scheduled_delay(EXPORT_INTERVAL)
        .with_max_export_batch_size(EXPORT_BATCH_SPANS)
        .with_max_queue_size(EXPORT_QUEUE_SPANS)
        .build();
    let processor = BatchSpanProcessor::builder(exporter)
        .with_batch_config(batch)
        .build();
    let provider = SdkTracerProvider::builder()
        .with_span_processor(processor)
        .with_resource(resource(&config.service_name))
        .build();
    Ok(Lens::from_provider(provider, config.capture()))
}

fn resource(service_name: &str) -> Resource {
    Resource::builder()
        .with_service_name(service_name.to_owned())
        .with_attribute(KeyValue::new(LENS_SDK_VERSION, env!("CARGO_PKG_VERSION")))
        .build()
}

/// Whether `sqlx::query` events at `DEBUG` reach any tracing layer. When they do not, there are no database spans.
pub fn database_events_enabled() -> bool {
    tracing::enabled!(target: "sqlx::query", tracing::Level::DEBUG)
}

impl Lens {
    fn from_provider(provider: SdkTracerProvider, capture: Arc<CaptureConfig>) -> Self {
        let tracer = provider.tracer("chepio-lens-sdk");
        Self {
            inner: Some(Arc::new(Inner {
                provider,
                tracer,
                capture,
                database: None,
            })),
        }
    }

    /// Exports synchronously to `exporter`, for tests that inspect spans.
    #[doc(hidden)]
    pub fn with_exporter(service_name: &str, exporter: impl SpanExporterTrait + 'static) -> Self {
        Self::with_exporter_config(
            Config {
                service_name: service_name.to_owned(),
                ..Config::default()
            },
            exporter,
        )
    }

    /// [`Lens::with_exporter`] with capture settings from `config`; its endpoint is ignored.
    #[doc(hidden)]
    pub fn with_exporter_config(
        config: Config,
        exporter: impl SpanExporterTrait + 'static,
    ) -> Self {
        Self::from_provider(
            SdkTracerProvider::builder()
                .with_simple_exporter(exporter)
                .with_resource(resource(&config.service_name))
                .build(),
            config.capture(),
        )
    }

    pub fn is_enabled(&self) -> bool {
        self.inner.is_some()
    }

    /// Names the database node for sqlx queries (ADR-0008).
    pub fn with_database(mut self, database: Database) -> Self {
        if let Some(inner) = self.inner.as_mut() {
            Arc::make_mut(inner).database = Some(database);
        }
        self
    }

    /// Tower layer for an axum `Router`: one server span per request, joined to the caller's trace via `traceparent`.
    pub fn http_layer(&self) -> HttpLayer {
        let inner = self.inner.as_ref();
        HttpLayer::new(
            inner.map(|inner| (inner.tracer.clone(), inner.capture.clone())),
            inner.is_some_and(|inner| inner.database.is_some()),
        )
    }

    /// Tracing layer that turns sqlx query events into database client spans. Add it to the app's subscriber.
    pub fn tracing_layer(&self) -> SqlxEventsLayer {
        SqlxEventsLayer::new(
            self.inner
                .as_ref()
                .map(|inner| (inner.tracer.clone(), inner.database.clone())),
        )
    }

    /// Sets a global tracing subscriber holding only [`Lens::tracing_layer`], for apps without a subscriber of their
    /// own. Fails if a global subscriber is already set.
    pub fn install_tracing(&self) -> Result<(), InitError> {
        if !self.is_enabled() {
            return Ok(());
        }
        tracing_subscriber::registry()
            .with(self.tracing_layer())
            .try_init()
            .map_err(|error| {
                InitError(format!(
                    "a tracing subscriber is already set ({error}); add lens.tracing_layer() to it"
                ))
            })
    }

    /// Flushes pending spans, waiting at most 2 s. Runs on its own thread, so it is safe inside async code.
    pub fn shutdown(&self) {
        if let Some(inner) = &self.inner {
            let provider = inner.provider.clone();
            let _ = thread::spawn(move || provider.shutdown_with_timeout(SHUTDOWN_TIMEOUT)).join();
        }
    }
}
