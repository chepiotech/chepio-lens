//! Activity contract (ADR-0016): a browser action and the trace it started become one activity through the UI API,
//! whatever arrives first, and its steps follow the call tree there and back (I13).

// Core
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use chepio_lens_collector::app::{Limits, build};
use chepio_lens_collector::handlers::{otlp_router, ui_router};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

const ORIGIN: &str = "http://localhost:5173";
const TRACE: &str = "0af7651916cd43dd8448eb211c80319c";
const FETCH: &str = "1111111111111111";
const SERVER: &str = "2222222222222222";
const QUERY: &str = "3333333333333333";
const ACTION: &str = "0123456789abcdef";
/// The browser's clock runs 10 s ahead of the API's: steps must not be ordered by comparing them (I12).
const BROWSER_MS: u64 = 1_793_000_010_000;
const SERVER_MS: u64 = 1_793_000_000_000;

fn app() -> (Router, Router) {
    let state = build(&[], &[ORIGIN.to_owned()], Limits::default());
    (otlp_router(state.clone()), ui_router(state))
}

fn ns(ms: u64) -> String {
    (ms * 1_000_000).to_string()
}

fn attributes(pairs: &[(&str, Value)]) -> Value {
    Value::Array(
        pairs
            .iter()
            .map(|(key, value)| json!({ "key": key, "value": value }))
            .collect(),
    )
}

fn resource(service: &str, browser: bool) -> Value {
    let mut pairs = vec![("service.name", json!({ "stringValue": service }))];
    if browser {
        pairs.push(("telemetry.sdk.language", json!({ "stringValue": "webjs" })));
    }
    json!({ "attributes": attributes(&pairs) })
}

fn traces(service: &str, browser: bool, spans: Vec<Value>) -> Value {
    json!({ "resourceSpans": [{ "resource": resource(service, browser), "scopeSpans": [{ "spans": spans }] }] })
}

fn browser_fetch() -> Value {
    traces(
        "demo-web",
        true,
        vec![json!({
            "traceId": TRACE, "spanId": FETCH, "name": "DELETE", "kind": 3,
            "startTimeUnixNano": ns(BROWSER_MS), "endTimeUnixNano": ns(BROWSER_MS + 40),
            "attributes": attributes(&[
                ("http.request.method", json!({ "stringValue": "DELETE" })),
                ("url.full", json!({ "stringValue": "http://localhost:5173/api/notes/7" })),
                ("http.response.status_code", json!({ "intValue": "204" })),
                ("lens.action.id", json!({ "stringValue": ACTION })),
            ]),
        })],
    )
}

fn api_spans() -> Value {
    traces(
        "demo-api",
        false,
        vec![
            json!({
                "traceId": TRACE, "spanId": SERVER, "parentSpanId": FETCH, "name": "DELETE /api/notes/{id}",
                "kind": 2, "startTimeUnixNano": ns(SERVER_MS + 5), "endTimeUnixNano": ns(SERVER_MS + 9),
                "attributes": attributes(&[
                    ("http.route", json!({ "stringValue": "/api/notes/{id}" })),
                    ("http.response.status_code", json!({ "intValue": "204" })),
                ]),
            }),
            json!({
                "traceId": TRACE, "spanId": QUERY, "parentSpanId": SERVER, "name": "DELETE demo", "kind": 3,
                "startTimeUnixNano": ns(SERVER_MS + 6), "endTimeUnixNano": ns(SERVER_MS + 8),
                "attributes": attributes(&[
                    ("db.system.name", json!({ "stringValue": "postgresql" })),
                    ("server.address", json!({ "stringValue": "db" })),
                    ("db.query.text", json!({ "stringValue": "DELETE FROM notes WHERE id = $1" })),
                    ("db.operation.name", json!({ "stringValue": "DELETE" })),
                    ("db.response.returned_rows", json!({ "intValue": "0" })),
                    ("lens.db.affected_rows", json!({ "intValue": "1" })),
                ]),
            }),
        ],
    )
}

fn action(body: &str, id: &str, time_ms: u64, trace: Option<(&str, &str)>) -> Value {
    let mut record = json!({
        "timeUnixNano": ns(time_ms), "severityNumber": 9, "body": { "stringValue": body },
        "attributes": attributes(&[
            ("lens.log.kind", json!({ "stringValue": "action" })),
            ("lens.action.id", json!({ "stringValue": id })),
        ]),
    });
    if let Some((trace, span)) = trace {
        record["traceId"] = json!(trace);
        record["spanId"] = json!(span);
    }
    json!({ "resourceLogs": [{ "resource": resource("demo-web", true), "scopeLogs": [{ "logRecords": [record] }] }] })
}

async fn post(router: &Router, path: &str, body: &Value, browser: bool) {
    let mut request = Request::post(path).header(header::CONTENT_TYPE, "application/json");
    if browser {
        request = request.header(header::ORIGIN, ORIGIN);
    }
    let response = router
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK, "POST {path}");
}

async fn get(router: &Router, uri: &str) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(Request::get(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn activities(ui: &Router, query: &str) -> Vec<Value> {
    let (status, page) = get(ui, &format!("/api/activities{query}")).await;
    assert_eq!(status, StatusCode::OK);
    page["activities"].as_array().unwrap().clone()
}

/// Reads SSE frames until an `activity` event arrives.
async fn next_activity_event(body: &mut Body) -> Value {
    let mut buffer = String::new();
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(2), body.frame())
            .await
            .expect("no activity event within 2 s")
            .unwrap()
            .unwrap();
        let Ok(data) = frame.into_data() else {
            continue;
        };
        buffer.push_str(std::str::from_utf8(&data).unwrap());
        while let Some(end) = buffer.find("\n\n") {
            let event: String = buffer.drain(..end + 2).collect();
            if event.contains("event: activity") {
                let data = event
                    .lines()
                    .find_map(|line| line.strip_prefix("data: "))
                    .unwrap();
                return serde_json::from_str(data).unwrap();
            }
        }
    }
}

#[tokio::test]
async fn a_trace_that_arrives_first_becomes_part_of_the_action_and_its_steps_go_there_and_back() {
    let (otlp, ui) = app();
    let events = ui
        .clone()
        .oneshot(Request::get("/api/events").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let mut events = events.into_body();

    post(&otlp, "/v1/traces", &api_spans(), false).await;
    let alone = activities(&ui, "").await;
    assert_eq!(alone.len(), 1);
    assert_eq!(alone[0]["id"], format!("trace:{TRACE}"));
    assert_eq!(alone[0]["origin"], "request");
    assert_eq!(
        next_activity_event(&mut events).await["replaces"],
        json!([])
    );

    post(&otlp, "/v1/traces", &browser_fetch(), true).await;
    let merged = next_activity_event(&mut events).await;
    assert_eq!(merged["activity"]["id"], format!("action:{ACTION}"));
    assert_eq!(merged["replaces"], json!([format!("trace:{TRACE}")]));

    post(
        &otlp,
        "/v1/logs",
        &action("click Delete", ACTION, BROWSER_MS - 2, Some((TRACE, FETCH))),
        true,
    )
    .await;
    let listed = activities(&ui, "").await;
    assert_eq!(listed.len(), 1, "{listed:#?}");
    let activity = &listed[0];
    assert_eq!(activity["origin"], "action");
    assert_eq!(activity["title"], "click Delete");
    assert_eq!(activity["service"], "demo-web");
    assert_eq!(
        activity["layers"],
        json!(["frontend", "backend", "database"])
    );
    assert_eq!(activity["status_code"], 204);
    // From the click to the end of the fetch, in the browser's clock.
    assert_eq!(activity["duration_ms"], 42.0);

    let (status, detail) = get(&ui, &format!("/api/activities/action:{ACTION}")).await;
    assert_eq!(status, StatusCode::OK);
    let steps = detail["steps"].as_array().unwrap();
    let kinds: Vec<&str> = steps
        .iter()
        .map(|step| step["kind"].as_str().unwrap())
        .collect();
    assert_eq!(
        kinds,
        [
            "action", "send", "receive", "query", "result", "respond", "response"
        ]
    );
    let texts: Vec<&str> = steps
        .iter()
        .map(|step| step["text"].as_str().unwrap())
        .collect();
    assert_eq!(
        texts,
        [
            "click Delete",
            "DELETE localhost:5173/api/notes/7",
            "DELETE /api/notes/{id}",
            "DELETE FROM notes WHERE id = $1",
            "1 row affected",
            "204",
            "204",
        ]
    );
    assert_eq!(steps[4]["node"], "db:postgresql:db");
    assert_eq!(steps[4]["duration_ms"], 2.0);
    // Offsets are as received, so the API's steps are about 10 s before the click (I12); the order is not.
    assert!(steps[2]["offset_ms"].as_f64().unwrap() < -9_000.0);
    assert_eq!(detail["truncated_steps"], 0);

    let (_, stats) = get(&ui, "/api/stats").await;
    assert_eq!(stats["activities"], 1);
}

#[tokio::test]
async fn a_click_that_starts_nothing_is_an_activity_of_its_own_and_filters_apply_to_any_line() {
    let (otlp, ui) = app();
    post(
        &otlp,
        "/v1/logs",
        &action("click Delete", ACTION, BROWSER_MS - 2, Some((TRACE, FETCH))),
        true,
    )
    .await;
    post(&otlp, "/v1/traces", &browser_fetch(), true).await;
    post(&otlp, "/v1/traces", &api_spans(), false).await;
    post(
        &otlp,
        "/v1/logs",
        &action(
            "click li (2 of 3) in ul#notes",
            "feedfacecafebeef",
            BROWSER_MS + 1_000,
            None,
        ),
        true,
    )
    .await;

    let all = activities(&ui, "").await;
    let ids: Vec<&str> = all
        .iter()
        .map(|activity| activity["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        ["action:feedfacecafebeef", &format!("action:{ACTION}")]
    );
    assert_eq!(all[0]["duration_ms"], Value::Null);
    assert_eq!(all[0]["layers"], json!(["frontend"]));

    let (_, lone) = get(&ui, "/api/activities/action:feedfacecafebeef").await;
    assert_eq!(lone["steps"].as_array().unwrap().len(), 1);
    assert_eq!(lone["steps"][0]["kind"], "action");

    let ids_for = |page: Vec<Value>| -> Vec<String> {
        page.iter()
            .map(|activity| activity["id"].as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(
        ids_for(activities(&ui, "?layer=database").await),
        [format!("action:{ACTION}")]
    );
    assert_eq!(
        ids_for(activities(&ui, "?q=notes%20where").await),
        [format!("action:{ACTION}")]
    );
    assert!(activities(&ui, "?origin=request").await.is_empty());
    assert!(activities(&ui, "?status=error").await.is_empty());
    let first = get(&ui, "/api/activities?limit=1").await.1;
    assert_eq!(first["activities"].as_array().unwrap().len(), 1);
    let before = first["next_before"].as_str().unwrap();
    assert_eq!(
        ids_for(activities(&ui, &format!("?before={before}")).await),
        [format!("action:{ACTION}")]
    );
}

#[tokio::test]
async fn unknown_filters_and_ids_are_refused_and_missing_activities_are_not_found() {
    let (_, ui) = app();
    assert_eq!(
        get(&ui, "/api/activities?origin=page").await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        get(&ui, "/api/activities?layer=cache").await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        get(&ui, "/api/activities?before=yesterday").await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        get(&ui, "/api/activities/span:1").await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        get(&ui, "/api/activities/action:a%2Fb").await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        get(&ui, &format!("/api/activities/action:{ACTION}"))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        get(&ui, &format!("/api/activities/trace:{TRACE}")).await.0,
        StatusCode::NOT_FOUND
    );
}
