#!/usr/bin/env bash
# Smoke test of a collector image run through collector/compose.yaml: it answers /healthz, publishes its ports on
# 127.0.0.1 only (ADR-0003), ingests an OTLP/JSON batch, and serves the embedded UI with its CSP.
# Usage: collector/image-smoke.sh <image>
#   docker build -f collector/Dockerfile -t chepio-lens:dev . && collector/image-smoke.sh chepio-lens:dev
set -euo pipefail

[ $# -eq 1 ] || { echo "usage: $0 <image>" >&2; exit 2; }
cd "$(dirname "$0")/.."
# Host ports away from 4318 and 4320, so a collector already running for development is not in the way.
export CHEPIO_LENS_IMAGE="$1" CHEPIO_LENS_OTLP_PORT=24318 CHEPIO_LENS_UI_PORT=24320
COMPOSE=(docker compose -f collector/compose.yaml -p chepio-lens-smoke)
OTLP=http://127.0.0.1:$CHEPIO_LENS_OTLP_PORT
LENS=http://127.0.0.1:$CHEPIO_LENS_UI_PORT

fail() { echo "FAIL: $*" >&2; "${COMPOSE[@]}" logs >&2 || true; exit 1; }
json() { python3 -I -c "import json, sys; data = json.load(sys.stdin); print($1)"; }

"${COMPOSE[@]}" up -d
trap '"${COMPOSE[@]}" down' EXIT

started=$(python3 -I -c 'import time; print(time.time())')
for _ in $(seq 1 60); do
  curl -fsS -o /dev/null "$LENS/healthz" 2>/dev/null && break
  sleep 0.5
done
curl -fsS -o /dev/null "$LENS/healthz" || fail "/healthz did not answer within 30 s"
ready=$(python3 -I -c "import time; print(round(time.time() - $started, 2))")

for port in 4318 4320; do
  published=$("${COMPOSE[@]}" port chepio-lens "$port")
  case "$published" in
    127.0.0.1:*) ;;
    *) fail "container port $port is published on '$published', expected 127.0.0.1 only" ;;
  esac
done

status=$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
  --data-binary @collector/tests/fixtures/demo_trace.json "$OTLP/v1/traces")
[ "$status" = 200 ] || fail "POST /v1/traces answered $status, expected 200"
spans=$(curl -fsS "$LENS/api/stats" | json "data['spans_received']")
[ "$spans" -gt 0 ] || fail "the collector received no spans from the fixture"

curl -fsS "$LENS/" | grep -q '<title>chepio-lens</title>' || fail "the map page is missing: UI not embedded"
csp=$(curl -fsS -o /dev/null -D - "$LENS/" | tr -d '\r' | awk -F': ' 'tolower($1) == "content-security-policy" {print $2}')
[ "$csp" = "default-src 'self'; connect-src 'self'" ] || fail "the map page sends CSP '$csp'"

echo "OK: $1 answered /healthz after ${ready} s, ingested $spans spans, serves the map; ports on 127.0.0.1 only"
