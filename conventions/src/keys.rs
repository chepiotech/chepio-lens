//! Attribute keys chepio-lens reads or writes. OpenTelemetry semantic convention names, plus the `lens.*`
//! extension (`docs/architecture/interfaces.md`).

// Resource
pub const SERVICE_NAME: &str = "service.name";
pub const TELEMETRY_SDK_LANGUAGE: &str = "telemetry.sdk.language";
/// `telemetry.sdk.language` value of browser SDKs.
pub const LANGUAGE_WEBJS: &str = "webjs";

// HTTP
pub const HTTP_REQUEST_METHOD: &str = "http.request.method";
pub const HTTP_ROUTE: &str = "http.route";
pub const HTTP_RESPONSE_STATUS_CODE: &str = "http.response.status_code";
pub const HTTP_REQUEST_HEADER_PREFIX: &str = "http.request.header.";
pub const HTTP_RESPONSE_HEADER_PREFIX: &str = "http.response.header.";
pub const HTTP_REQUEST_BODY_SIZE: &str = "http.request.body.size";
pub const HTTP_RESPONSE_BODY_SIZE: &str = "http.response.body.size";
pub const URL_FULL: &str = "url.full";
pub const URL_PATH: &str = "url.path";
pub const URL_QUERY: &str = "url.query";
pub const URL_SCHEME: &str = "url.scheme";
pub const SERVER_ADDRESS: &str = "server.address";
pub const SERVER_PORT: &str = "server.port";

// RPC (semconv 1.44.0 release candidate, ADR-0015)
pub const RPC_SYSTEM_NAME: &str = "rpc.system.name";
pub const RPC_METHOD: &str = "rpc.method";
pub const RPC_METHOD_ORIGINAL: &str = "rpc.method_original";
pub const RPC_RESPONSE_STATUS_CODE: &str = "rpc.response.status_code";

// Database
pub const DB_SYSTEM_NAME: &str = "db.system.name";
pub const DB_NAMESPACE: &str = "db.namespace";
pub const DB_QUERY_TEXT: &str = "db.query.text";
pub const DB_OPERATION_NAME: &str = "db.operation.name";
pub const DB_COLLECTION_NAME: &str = "db.collection.name";

// Errors
pub const ERROR_TYPE: &str = "error.type";

// chepio-lens extension
pub const LENS_HTTP_REQUEST_BODY: &str = "lens.http.request.body";
pub const LENS_HTTP_RESPONSE_BODY: &str = "lens.http.response.body";
pub const LENS_HTTP_REQUEST_BODY_TRUNCATED: &str = "lens.http.request.body.truncated";
pub const LENS_HTTP_RESPONSE_BODY_TRUNCATED: &str = "lens.http.response.body.truncated";
pub const LENS_REDACTION_COUNT: &str = "lens.redaction.count";
/// Resource attribute overriding the node kind: `frontend` or `service`.
pub const LENS_NODE_KIND: &str = "lens.node.kind";
pub const LENS_SDK_VERSION: &str = "lens.sdk.version";

/// Log record kind: `action` for browser user actions; all other records are app logs.
pub const LENS_LOG_KIND: &str = "lens.log.kind";
/// Log body or attributes were shortened before export.
pub const LENS_LOG_TRUNCATED: &str = "lens.log.truncated";
