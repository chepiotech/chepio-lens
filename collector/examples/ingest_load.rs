//! Load generator for the ingest measurements in `docs/architecture/quality-attributes.md`: posts OTLP/protobuf
//! batches of distinct traces (one server span and three database spans each) over keep-alive connections.
//!
//! cargo run --release -p chepio-lens-collector --example ingest_load -- \
//!     [--target 127.0.0.1:4318] [--seconds 20] [--workers 4] [--traces-per-batch 50] [--rate <spans per second>]

// Core
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{AnyValue, KeyValue, any_value};
use opentelemetry_proto::tonic::resource::v1::Resource;
use opentelemetry_proto::tonic::trace::v1::{ResourceSpans, ScopeSpans, Span};
use prost::Message;

const SPANS_PER_TRACE: u64 = 4;

struct Args {
    target: String,
    seconds: u64,
    workers: u64,
    traces_per_batch: u64,
    rate: Option<u64>,
}

fn args() -> Args {
    let mut args = Args {
        target: "127.0.0.1:4318".into(),
        seconds: 20,
        workers: 4,
        traces_per_batch: 50,
        rate: None,
    };
    let mut it = std::env::args().skip(1);
    while let (Some(flag), Some(value)) = (it.next(), it.next()) {
        match flag.as_str() {
            "--target" => args.target = value,
            "--seconds" => args.seconds = value.parse().expect("--seconds"),
            "--workers" => args.workers = value.parse().expect("--workers"),
            "--traces-per-batch" => {
                args.traces_per_batch = value.parse().expect("--traces-per-batch")
            }
            "--rate" => args.rate = Some(value.parse().expect("--rate")),
            other => panic!("unknown flag {other}"),
        }
    }
    args
}

fn text(key: &str, value: &str) -> KeyValue {
    KeyValue {
        key: key.into(),
        value: Some(AnyValue {
            value: Some(any_value::Value::StringValue(value.into())),
        }),
        ..KeyValue::default()
    }
}

fn int(key: &str, value: i64) -> KeyValue {
    KeyValue {
        key: key.into(),
        value: Some(AnyValue {
            value: Some(any_value::Value::IntValue(value)),
        }),
        ..KeyValue::default()
    }
}

/// `first_trace` makes trace ids unique across workers and batches.
fn batch(first_trace: u64, traces: u64) -> Vec<u8> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64;
    let mut spans = Vec::new();
    for trace in first_trace..first_trace + traces {
        let trace_id = [trace.to_be_bytes(), 1u64.to_be_bytes()].concat();
        let server_id = (trace * 8 + 1).to_be_bytes().to_vec();
        spans.push(Span {
            trace_id: trace_id.clone(),
            span_id: server_id.clone(),
            name: "GET /api/notes".into(),
            kind: 2,
            start_time_unix_nano: now,
            end_time_unix_nano: now + 5_000_000,
            attributes: vec![
                text("http.request.method", "GET"),
                text("http.route", "/api/notes"),
                int("http.response.status_code", 200),
            ],
            ..Span::default()
        });
        for query in 0..SPANS_PER_TRACE - 1 {
            spans.push(Span {
                trace_id: trace_id.clone(),
                span_id: (trace * 8 + 2 + query).to_be_bytes().to_vec(),
                parent_span_id: server_id.clone(),
                name: "SELECT demo".into(),
                kind: 3,
                start_time_unix_nano: now + 1_000_000,
                end_time_unix_nano: now + 2_000_000,
                attributes: vec![
                    text("db.system.name", "postgresql"),
                    text("server.address", "db"),
                    int("server.port", 5432),
                    text("db.namespace", "demo"),
                    text(
                        "db.query.text",
                        "SELECT id, text FROM notes ORDER BY id DESC LIMIT $1",
                    ),
                ],
                ..Span::default()
            });
        }
    }
    ExportTraceServiceRequest {
        resource_spans: vec![ResourceSpans {
            resource: Some(Resource {
                attributes: vec![text("service.name", "load-api")],
                ..Resource::default()
            }),
            scope_spans: vec![ScopeSpans {
                spans,
                ..ScopeSpans::default()
            }],
            ..ResourceSpans::default()
        }],
    }
    .encode_to_vec()
}

/// One HTTP/1.1 request on a keep-alive connection; returns the status code.
fn post(stream: &mut BufReader<TcpStream>, host: &str, body: &[u8]) -> u16 {
    let head = format!(
        "POST /v1/traces HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/x-protobuf\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    let writer = stream.get_mut();
    writer.write_all(head.as_bytes()).unwrap();
    writer.write_all(body).unwrap();
    let mut status_line = String::new();
    stream.read_line(&mut status_line).unwrap();
    let mut length = 0;
    loop {
        let mut line = String::new();
        stream.read_line(&mut line).unwrap();
        if line == "\r\n" {
            break;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            length = value.trim().parse().unwrap();
        }
    }
    let mut response = vec![0; length];
    stream.read_exact(&mut response).unwrap();
    status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0)
}

fn main() {
    let args = args();
    let spans_per_batch = args.traces_per_batch * SPANS_PER_TRACE;
    let interval = args.rate.map(|rate| {
        Duration::from_secs_f64(spans_per_batch as f64 * args.workers as f64 / rate as f64)
    });
    let deadline = Instant::now() + Duration::from_secs(args.seconds);
    let failed = AtomicU64::new(0);
    let started = Instant::now();
    let latencies: Vec<Duration> = thread::scope(|scope| {
        let workers: Vec<_> = (0..args.workers)
            .map(|worker| {
                let (args, failed) = (&args, &failed);
                scope.spawn(move || {
                    let mut stream = BufReader::new(
                        TcpStream::connect(&args.target).expect("collector not reachable"),
                    );
                    let mut latencies = Vec::new();
                    let mut next = Instant::now();
                    let mut trace = (worker << 40) + 1;
                    while Instant::now() < deadline {
                        let body = batch(trace, args.traces_per_batch);
                        trace += args.traces_per_batch;
                        let sent = Instant::now();
                        if post(&mut stream, &args.target, &body) != 200 {
                            failed.fetch_add(1, Ordering::Relaxed);
                        }
                        latencies.push(sent.elapsed());
                        if let Some(interval) = interval {
                            next += interval;
                            thread::sleep(next.saturating_duration_since(Instant::now()));
                        }
                    }
                    latencies
                })
            })
            .collect();
        workers
            .into_iter()
            .flat_map(|worker| worker.join().unwrap())
            .collect()
    });
    let elapsed = started.elapsed().as_secs_f64();
    let mut sorted = latencies.clone();
    sorted.sort();
    let quantile = |q: f64| sorted[((sorted.len() as f64 * q) as usize).min(sorted.len() - 1)];
    let spans = latencies.len() as u64 * spans_per_batch;
    println!(
        "batches={} spans={} spans_per_s={:.0} batch_p50={:?} batch_p99={:?} batch_max={:?} failed={}",
        latencies.len(),
        spans,
        spans as f64 / elapsed,
        quantile(0.5),
        quantile(0.99),
        sorted.last().unwrap(),
        failed.load(Ordering::Relaxed)
    );
}
