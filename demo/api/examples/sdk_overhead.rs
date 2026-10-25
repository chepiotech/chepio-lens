//! SDK overhead measurement for `docs/architecture/quality-attributes.md`. Starts the demo API once per mode, each in
//! its own process (the SDK installs a global tracing subscriber), then sends every process the same request mix in
//! turn, round after round, so drift on the machine hits all modes alike. Latency is compared with `bare` within each
//! round, and results are medians over the rounds, so a stall during one slot does not decide them.
//!
//! Modes: `bare` (no SDK layer, as built without the `lens` feature), `noop` (SDK without an endpoint), `on` (export,
//! bodies off), `bodies` (export, bodies on with the default 16 KiB limit), `unreachable` (bodies on, nothing listens
//! at the endpoint).
//!
//! DATABASE_URL=postgres://demo:demo@127.0.0.1:55432/demo \
//! cargo run --release -p demo-api --features lens --example sdk_overhead -- \
//!     [--collector http://127.0.0.1:4318] [--modes bare,noop,on,bodies,unreachable] [--rate 100] [--workers 4] \
//!     [--seconds 10] [--rounds 10]
//!
//! It creates 100 notes of 1000 characters for the request mix and deletes them at the end.

// Core
use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener as StdTcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::str::FromStr;
use std::time::{Duration, Instant};
use std::{env, thread};

use chepio_lens_sdk::{Config, Database};
use serde_json::{Value, json};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use tokio::net::TcpListener;
// Handlers
use demo_api::{MIGRATOR, app};

/// `notes::LIST_LIMIT`, so `GET /api/notes` returns about 100 KB: more than the 16 KiB body limit.
const NOTES: usize = 100;
const NOTE_CHARS: usize = 1000;
const LOGIN_BODY: &str = r#"{"username":"demo","password":"demo-password"}"#;
const WARM_UP: Duration = Duration::from_secs(2);
// As in `src/main.rs`.
const DB_MAX_CONNECTIONS: u32 = 5;
const DB_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(3);
const DB_STATEMENT_TIMEOUT: &str = "5s";

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Mode {
    Bare,
    Noop,
    On,
    Bodies,
    Unreachable,
}

impl Mode {
    const ALL: [Mode; 5] = [
        Mode::Bare,
        Mode::Noop,
        Mode::On,
        Mode::Bodies,
        Mode::Unreachable,
    ];

    fn name(self) -> &'static str {
        match self {
            Mode::Bare => "bare",
            Mode::Noop => "noop",
            Mode::On => "on",
            Mode::Bodies => "bodies",
            Mode::Unreachable => "unreachable",
        }
    }

    fn parse(name: &str) -> Option<Mode> {
        Mode::ALL.into_iter().find(|mode| mode.name() == name)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Kind {
    Health,
    Login,
    GetNote,
    PutNote,
    ListNotes,
}

impl Kind {
    const ALL: [Kind; 5] = [
        Kind::Health,
        Kind::Login,
        Kind::GetNote,
        Kind::PutNote,
        Kind::ListNotes,
    ];

    fn label(self) -> &'static str {
        match self {
            Kind::Health => "GET /api/health",
            Kind::Login => "POST /api/login",
            Kind::GetNote => "GET /api/notes/{id}",
            Kind::PutNote => "PUT /api/notes/{id}",
            Kind::ListNotes => "GET /api/notes (100 KB)",
        }
    }
}

struct Args {
    /// Set in the server processes this example starts.
    serve: Option<Mode>,
    endpoint: Option<String>,
    collector: String,
    modes: Vec<Mode>,
    rate: u32,
    workers: u32,
    seconds: u64,
    rounds: u32,
}

fn args() -> Args {
    let mut args = Args {
        serve: None,
        endpoint: None,
        collector: "http://127.0.0.1:4318".into(),
        modes: Mode::ALL.to_vec(),
        rate: 100,
        workers: 4,
        seconds: 10,
        rounds: 10,
    };
    let mut it = env::args().skip(1);
    while let (Some(flag), Some(value)) = (it.next(), it.next()) {
        match flag.as_str() {
            "--serve" => args.serve = Some(Mode::parse(&value).expect("--serve")),
            "--endpoint" => args.endpoint = Some(value),
            "--collector" => args.collector = value,
            "--modes" => {
                args.modes = value
                    .split(',')
                    .map(|name| Mode::parse(name.trim()).expect("--modes"))
                    .collect()
            }
            "--rate" => args.rate = value.parse().expect("--rate"),
            "--workers" => args.workers = value.parse().expect("--workers"),
            "--seconds" => args.seconds = value.parse().expect("--seconds"),
            "--rounds" => args.rounds = value.parse().expect("--rounds"),
            other => panic!("unknown flag {other}"),
        }
    }
    args
}

/// The demo API as `src/main.rs` builds it, with the SDK set up for `mode`. Prints its address once it listens.
async fn serve(mode: Mode, endpoint: Option<String>) {
    let database_url = env::var("DATABASE_URL").expect("DATABASE_URL is not set");
    let lens = (mode != Mode::Bare).then(|| {
        let lens = chepio_lens_sdk::init_with(Config {
            service_name: "demo-api".into(),
            endpoint,
            capture_bodies: mode != Mode::On,
            ..Config::default()
        })
        .expect("SDK init")
        .with_database(Database::postgres_url(&database_url));
        lens.install_tracing().expect("tracing subscriber");
        lens
    });
    let options = PgConnectOptions::from_str(&database_url)
        .expect("DATABASE_URL")
        .options([("statement_timeout", DB_STATEMENT_TIMEOUT)]);
    let pool = PgPoolOptions::new()
        .max_connections(DB_MAX_CONNECTIONS)
        .acquire_timeout(DB_ACQUIRE_TIMEOUT)
        .connect_with(options)
        .await
        .expect("database not reachable");
    MIGRATOR.run(&pool).await.expect("migrations");
    let mut router = app(pool);
    if let Some(lens) = &lens {
        router = router.layer(lens.http_layer());
    }
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    println!("{}", listener.local_addr().unwrap());
    axum::serve(listener, router).await.unwrap();
}

/// Demo API processes, one per mode; killed on drop, also when the measurement panics.
struct Servers(Vec<(Mode, SocketAddr, Child)>);

impl Drop for Servers {
    fn drop(&mut self) {
        for (_, _, child) in &mut self.0 {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn start(mode: Mode, endpoint: Option<&str>) -> (Mode, SocketAddr, Child) {
    let mut command = Command::new(env::current_exe().unwrap());
    command
        .args(["--serve", mode.name()])
        .stdout(Stdio::piped());
    if let Some(endpoint) = endpoint {
        command.args(["--endpoint", endpoint]);
    }
    let mut child = command.spawn().expect("start the demo API");
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let addr = line
        .trim()
        .parse()
        .unwrap_or_else(|_| panic!("the {} server did not start", mode.name()));
    (mode, addr, child)
}

/// An endpoint nothing listens at: a port taken from the OS and released at once.
fn closed_endpoint() -> String {
    let port = StdTcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    format!("http://127.0.0.1:{port}")
}

/// `host:port` of an `http://host:port` URL.
fn authority(url: &str) -> &str {
    url.trim_start_matches("http://").trim_end_matches('/')
}

struct Response {
    status: u16,
    body: Vec<u8>,
    close: bool,
}

fn invalid(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, format!("invalid {what}"))
}

/// Reads one line; the connection ending first is an error.
fn read_line(reader: &mut impl BufRead, line: &mut String) -> io::Result<()> {
    line.clear();
    match reader.read_line(line)? {
        0 => Err(io::ErrorKind::UnexpectedEof.into()),
        _ => Ok(()),
    }
}

/// Reads one HTTP/1.1 response with a `Content-Length` or chunked body.
fn read_response(reader: &mut impl BufRead) -> io::Result<Response> {
    let mut line = String::new();
    read_line(reader, &mut line)?;
    let status = line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| invalid("status line"))?;
    let (mut length, mut chunked, mut close) = (0, false, false);
    loop {
        read_line(reader, &mut line)?;
        if line == "\r\n" {
            break;
        }
        let header = line.to_ascii_lowercase();
        let Some((name, value)) = header.split_once(':') else {
            return Err(invalid("header"));
        };
        match (name.trim(), value.trim()) {
            ("content-length", value) => {
                length = value.parse().map_err(|_| invalid("content-length"))?
            }
            ("transfer-encoding", value) => chunked = value.contains("chunked"),
            ("connection", value) => close = value == "close",
            _ => {}
        }
    }
    let body = if chunked {
        read_chunked(reader)?
    } else {
        let mut body = vec![0; length];
        reader.read_exact(&mut body)?;
        body
    };
    Ok(Response {
        status,
        body,
        close,
    })
}

fn read_chunked(reader: &mut impl BufRead) -> io::Result<Vec<u8>> {
    let mut body = Vec::new();
    let mut line = String::new();
    loop {
        read_line(reader, &mut line)?;
        let size = line.trim().split(';').next().unwrap_or_default();
        let size = usize::from_str_radix(size, 16).map_err(|_| invalid("chunk size"))?;
        if size == 0 {
            // Trailers, if any, end with an empty line.
            loop {
                read_line(reader, &mut line)?;
                if line == "\r\n" {
                    return Ok(body);
                }
            }
        }
        let start = body.len();
        body.resize(start + size + 2, 0);
        reader.read_exact(&mut body[start..])?;
        body.truncate(start + size);
    }
}

fn http_request(method: &str, path: &str, body: &str) -> Vec<u8> {
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\n");
    if !body.is_empty() {
        head += &format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        );
    }
    head += "\r\n";
    [head.as_bytes(), body.as_bytes()].concat()
}

fn request(kind: Kind, note: i64, note_body: &str) -> Vec<u8> {
    match kind {
        Kind::Health => http_request("GET", "/api/health", ""),
        Kind::Login => http_request("POST", "/api/login", LOGIN_BODY),
        Kind::GetNote => http_request("GET", &format!("/api/notes/{note}"), ""),
        Kind::PutNote => http_request("PUT", &format!("/api/notes/{note}"), note_body),
        Kind::ListNotes => http_request("GET", "/api/notes", ""),
    }
}

/// A keep-alive connection that reconnects after an error or `Connection: close`.
struct Connection {
    addr: SocketAddr,
    stream: Option<BufReader<TcpStream>>,
}

impl Connection {
    fn new(addr: SocketAddr) -> Self {
        Self { addr, stream: None }
    }

    fn send(&mut self, request: &[u8]) -> io::Result<Response> {
        let stream = match &mut self.stream {
            Some(stream) => stream,
            None => {
                let stream = TcpStream::connect(self.addr)?;
                stream.set_nodelay(true)?;
                self.stream.insert(BufReader::new(stream))
            }
        };
        let response = stream
            .get_mut()
            .write_all(request)
            .and_then(|()| read_response(stream));
        if !matches!(&response, Ok(response) if !response.close) {
            self.stream = None;
        }
        response
    }

    /// For setup and cleanup, where anything but `expected` stops the measurement.
    fn expect(&mut self, request: &[u8], expected: u16) -> Vec<u8> {
        let response = self.send(request).expect("demo API not reachable");
        assert_eq!(response.status, expected, "unexpected status in setup");
        response.body
    }
}

fn create_notes(addr: SocketAddr, note_body: &str) -> Vec<i64> {
    let mut connection = Connection::new(addr);
    (0..NOTES)
        .map(|_| {
            let body = connection.expect(&http_request("POST", "/api/notes", note_body), 201);
            let note: Value = serde_json::from_slice(&body).expect("note JSON");
            note["id"].as_i64().expect("note id")
        })
        .collect()
}

fn delete_notes(addr: SocketAddr, notes: &[i64]) {
    let mut connection = Connection::new(addr);
    for note in notes {
        connection.expect(
            &http_request("DELETE", &format!("/api/notes/{note}"), ""),
            204,
        );
    }
}

struct Load<'a> {
    rate: u32,
    workers: u32,
    notes: &'a [i64],
    note_body: &'a str,
}

#[derive(Default)]
struct Slot {
    /// Latency in microseconds of each successful request.
    samples: Vec<(Kind, u32)>,
    errors: u64,
}

/// Sends `rate` requests per second to `addr` for `duration` over `workers` keep-alive connections, each on a fixed
/// schedule. A request sent late because the previous response was slow counts from its scheduled start, so the
/// server is charged for the delay; one sent after a sleep counts from the wake-up, so a late wake-up of this
/// client (timer coalescing on a loaded machine) is not. Each worker cycles through the kinds, offset by its index,
/// so every kind runs alongside the others.
fn run_slot(addr: SocketAddr, load: &Load, duration: Duration) -> Slot {
    let workers = load.workers as usize;
    let interval = Duration::from_secs_f64(f64::from(load.workers) / f64::from(load.rate));
    let begin = Instant::now();
    let deadline = begin + duration;
    thread::scope(|scope| {
        let handles: Vec<_> = (0..workers)
            .map(|worker| {
                scope.spawn(move || {
                    let start = begin + interval.mul_f64(worker as f64 / workers as f64);
                    let mut connection = Connection::new(addr);
                    let mut slot = Slot::default();
                    for n in 0.. {
                        let scheduled = start + interval * n;
                        if scheduled >= deadline {
                            break;
                        }
                        let step = n as usize;
                        let kind = Kind::ALL[(step + worker) % Kind::ALL.len()];
                        let note = load.notes[(step * workers + worker) % load.notes.len()];
                        let request = request(kind, note, load.note_body);
                        let now = Instant::now();
                        let from = if now >= scheduled {
                            scheduled
                        } else {
                            thread::sleep(scheduled - now);
                            Instant::now()
                        };
                        match connection.send(&request) {
                            Ok(response) if (200..300).contains(&response.status) => {
                                let micros = from.elapsed().as_micros();
                                slot.samples
                                    .push((kind, u32::try_from(micros).unwrap_or(u32::MAX)));
                            }
                            _ => slot.errors += 1,
                        }
                    }
                    slot
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .fold(Slot::default(), |mut all, slot| {
                all.samples.extend(slot.samples);
                all.errors += slot.errors;
                all
            })
    })
}

/// Nearest-rank quantile of sorted values.
fn quantile(sorted: &[u32], q: f64) -> u32 {
    let rank = (q * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

/// Median, ignoring NaN (a slot without a successful request); NaN if nothing is left.
fn median(mut values: Vec<f64>) -> f64 {
    values.retain(|value| !value.is_nan());
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    match values.len() {
        0 => f64::NAN,
        len if len % 2 == 0 => (values[middle - 1] + values[middle]) / 2.0,
        _ => values[middle],
    }
}

fn ms(micros: f64) -> String {
    format!("{:.2}", micros / 1000.0)
}

fn signed_ms(micros: f64) -> String {
    format!("{:+.2}", micros / 1000.0)
}

/// Latencies of one round in microseconds, per mode and kind.
type Round = HashMap<(Mode, Kind), Vec<u32>>;

/// Quantile `q` of the requests of `kinds` that `mode` served in `round`; NaN if there are none.
fn round_quantile(round: &Round, mode: Mode, kinds: &[Kind], q: f64) -> f64 {
    let mut values: Vec<u32> = kinds
        .iter()
        .flat_map(|kind| round[&(mode, *kind)].iter().copied())
        .collect();
    values.sort_unstable();
    match values.is_empty() {
        true => f64::NAN,
        false => f64::from(quantile(&values, q)),
    }
}

/// Every statistic is computed per round and summarized by its median over the rounds. A difference to `bare` is
/// taken within each round, where the modes ran one after another, before the median. A stall of the machine or the
/// database during one slot then moves no result; the per-round table at the end shows such stalls.
fn report(args: &Args, rounds: &[Round], errors: &HashMap<Mode, u64>) {
    let stat = |mode: Mode, kinds: &[Kind], q: f64| {
        median(
            rounds
                .iter()
                .map(|round| round_quantile(round, mode, kinds, q))
                .collect(),
        )
    };
    let has_bare = args.modes.contains(&Mode::Bare);
    let delta = |mode: Mode, kinds: &[Kind], q: f64| match has_bare {
        true => signed_ms(median(
            rounds
                .iter()
                .map(|round| {
                    round_quantile(round, mode, kinds, q)
                        - round_quantile(round, Mode::Bare, kinds, q)
                })
                .collect(),
        )),
        false => "-".to_owned(),
    };
    let header = |title: &str| {
        print!("\n{title:<24}");
        for mode in &args.modes {
            print!(" {:>15}", mode.name());
        }
        println!();
    };

    println!(
        "\n{} req/s per mode over {} connections, {} rounds of {} s per mode, {} request kinds in equal parts",
        args.rate,
        args.workers,
        args.rounds,
        args.seconds,
        Kind::ALL.len()
    );
    println!(
        "Median over rounds of each round's quantile; Δ: median of the per-round difference to bare"
    );
    println!(
        "\n{:<12} {:>8} {:>6} {:>7} {:>7} {:>7} {:>7} {:>7} {:>7} {:>8}",
        "mode",
        "requests",
        "errors",
        "p50 ms",
        "p95 ms",
        "p99 ms",
        "Δp50",
        "Δp95",
        "Δp99",
        "max ms"
    );
    for &mode in &args.modes {
        let all = || {
            rounds
                .iter()
                .flat_map(move |round| Kind::ALL.iter().map(move |kind| &round[&(mode, *kind)]))
        };
        let requests: usize = all().map(Vec::len).sum();
        let max = all().flatten().copied().max().unwrap_or_default();
        let [p50, p95, p99] = [0.5, 0.95, 0.99].map(|q| ms(stat(mode, &Kind::ALL, q)));
        let [d50, d95, d99] = [0.5, 0.95, 0.99].map(|q| delta(mode, &Kind::ALL, q));
        println!(
            "{:<12} {requests:>8} {:>6} {p50:>7} {p95:>7} {p99:>7} {d50:>7} {d95:>7} {d99:>7} {:>8}",
            mode.name(),
            errors[&mode],
            ms(f64::from(max))
        );
    }

    header("p50 / p95 ms by request");
    for kind in Kind::ALL {
        print!("{:<24}", kind.label());
        for &mode in &args.modes {
            let cell = format!(
                "{} / {}",
                ms(stat(mode, &[kind], 0.5)),
                ms(stat(mode, &[kind], 0.95))
            );
            print!(" {cell:>15}");
        }
        println!();
    }

    if has_bare {
        header("Δp50 / Δp95 ms");
        for kind in Kind::ALL {
            print!("{:<24}", kind.label());
            for &mode in &args.modes {
                let cell = format!(
                    "{} / {}",
                    delta(mode, &[kind], 0.5),
                    delta(mode, &[kind], 0.95)
                );
                print!(" {cell:>15}");
            }
            println!();
        }
    }

    header("p95 ms per round");
    for (index, round) in rounds.iter().enumerate() {
        print!("{:<24}", format!("round {}", index + 1));
        for &mode in &args.modes {
            print!(" {:>15}", ms(round_quantile(round, mode, &Kind::ALL, 0.95)));
        }
        println!();
    }
}

fn main() {
    let args = args();
    if let Some(mode) = args.serve {
        tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(serve(mode, args.endpoint));
        return;
    }
    let exports = args
        .modes
        .iter()
        .any(|mode| matches!(mode, Mode::On | Mode::Bodies));
    if exports && TcpStream::connect(authority(&args.collector)).is_err() {
        panic!(
            "no collector at {}; start one or pass --collector",
            args.collector
        );
    }
    let unreachable = closed_endpoint();
    let mut servers = Servers(Vec::new());
    for &mode in &args.modes {
        let endpoint = match mode {
            Mode::Bare | Mode::Noop => None,
            Mode::On | Mode::Bodies => Some(args.collector.as_str()),
            Mode::Unreachable => Some(unreachable.as_str()),
        };
        servers.0.push(start(mode, endpoint));
    }
    let first = servers.0[0].1;

    let text: String = "Overhead measurement note. "
        .repeat(NOTE_CHARS)
        .chars()
        .take(NOTE_CHARS)
        .collect();
    let note_body = json!({ "text": text }).to_string();
    let notes = create_notes(first, &note_body);
    let load = Load {
        rate: args.rate,
        workers: args.workers,
        notes: &notes,
        note_body: &note_body,
    };

    for (_, addr, _) in &servers.0 {
        run_slot(*addr, &load, WARM_UP);
    }
    let mut errors: HashMap<Mode, u64> = args.modes.iter().map(|mode| (*mode, 0)).collect();
    let mut rounds = Vec::new();
    for round in 0..args.rounds as usize {
        let mut latencies = Round::new();
        for &mode in &args.modes {
            for kind in Kind::ALL {
                latencies.insert((mode, kind), Vec::new());
            }
        }
        // Each round starts with the next mode, so no mode always runs first or last.
        for i in 0..servers.0.len() {
            let (mode, addr, _) = servers.0[(i + round) % servers.0.len()];
            eprintln!("round {} of {}: {}", round + 1, args.rounds, mode.name());
            let slot = run_slot(addr, &load, Duration::from_secs(args.seconds));
            *errors.get_mut(&mode).unwrap() += slot.errors;
            for (kind, micros) in slot.samples {
                latencies.get_mut(&(mode, kind)).unwrap().push(micros);
            }
        }
        rounds.push(latencies);
    }

    delete_notes(first, &notes);
    report(&args, &rounds, &errors);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_responses_with_a_length_and_chunked_on_one_connection() {
        let wire = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}\
HTTP/1.1 201 Created\r\nTransfer-Encoding: chunked\r\n\r\n3;ext=1\r\nabc\r\nA\r\n0123456789\r\n0\r\n\r\n\
HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n";
        let mut reader = &wire[..];

        let first = read_response(&mut reader).unwrap();
        assert_eq!(
            (first.status, first.body.as_slice(), first.close),
            (200, &b"{}"[..], false)
        );
        let second = read_response(&mut reader).unwrap();
        assert_eq!(
            (second.status, second.body.as_slice()),
            (201, &b"abc0123456789"[..])
        );
        let third = read_response(&mut reader).unwrap();
        assert_eq!(
            (third.status, third.body.len(), third.close),
            (204, 0, true)
        );
        assert!(reader.is_empty());
    }

    #[test]
    fn a_response_cut_short_is_an_error() {
        assert!(
            read_response(&mut &b"HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nab"[..]).is_err()
        );
        assert!(read_response(&mut &b"HTTP/1.1 200 OK\r\n"[..]).is_err());
        assert!(read_response(&mut &b""[..]).is_err());
    }

    #[test]
    fn requests_carry_a_length_only_with_a_body() {
        assert_eq!(
            request(Kind::GetNote, 7, "{}"),
            b"GET /api/notes/7 HTTP/1.1\r\nHost: localhost\r\n\r\n"
        );
        let login = String::from_utf8(request(Kind::Login, 7, "{}")).unwrap();
        assert!(login.starts_with("POST /api/login HTTP/1.1\r\n"));
        assert!(login.ends_with(&format!(
            "Content-Length: {}\r\n\r\n{LOGIN_BODY}",
            LOGIN_BODY.len()
        )));
    }

    #[test]
    fn quantile_uses_the_nearest_rank() {
        let values: Vec<u32> = (1..=100).collect();
        assert_eq!(quantile(&values, 0.5), 50);
        assert_eq!(quantile(&values, 0.95), 95);
        assert_eq!(quantile(&values, 1.0), 100);
        assert_eq!(quantile(&values, 0.0), 1);
        assert_eq!(quantile(&[7], 0.99), 7);
    }

    #[test]
    fn median_skips_slots_without_requests() {
        assert_eq!(median(vec![3.0, 1.0, 2.0]), 2.0);
        assert_eq!(median(vec![4.0, 1.0, 3.0, 2.0]), 2.5);
        assert_eq!(median(vec![f64::NAN, 5.0]), 5.0);
        assert!(median(vec![f64::NAN]).is_nan());
    }

    #[test]
    fn round_quantiles_join_the_given_kinds() {
        let mut round = Round::new();
        round.insert((Mode::Bare, Kind::Health), vec![1, 2, 3]);
        round.insert((Mode::Bare, Kind::Login), vec![10, 20]);
        round.insert((Mode::On, Kind::Health), Vec::new());

        assert_eq!(
            round_quantile(&round, Mode::Bare, &[Kind::Health], 1.0),
            3.0
        );
        assert_eq!(
            round_quantile(&round, Mode::Bare, &[Kind::Health, Kind::Login], 1.0),
            20.0
        );
        assert!(round_quantile(&round, Mode::On, &[Kind::Health], 0.5).is_nan());
    }

    #[test]
    fn modes_parse_by_name() {
        for mode in Mode::ALL {
            assert_eq!(Mode::parse(mode.name()), Some(mode));
        }
        assert_eq!(Mode::parse("off"), None);
        assert_eq!(authority("http://127.0.0.1:4318/"), "127.0.0.1:4318");
    }
}
