#!/usr/bin/env bash
# End-to-end check: demo app + collector in compose. Calls the demo API and asserts that the collector's map shows
# demo-api → postgres with the right number of calls within 2 seconds.
# Usage: demo/e2e/backend-db.sh [--no-build] [--down]
set -euo pipefail

cd "$(dirname "$0")/../.."
COMPOSE=(docker compose -f demo/compose.yaml)
API=http://127.0.0.1:8080
LENS=http://127.0.0.1:4320
DB_EDGE='svc:demo-api->db:postgresql:db:5432/demo'
BUILD=--build
DOWN=false
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD= ;;
    --down) DOWN=true ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

fail() { echo "FAIL: $*" >&2; exit 1; }
json() { python3 -I -c "import json, sys; data = json.load(sys.stdin); print($1)"; }

"${COMPOSE[@]}" up -d $BUILD
if $DOWN; then trap '"${COMPOSE[@]}" down' EXIT; fi

wait_for() {
  for _ in $(seq 1 120); do
    curl -fsS -o /dev/null "$1" && return 0
    sleep 1
  done
  fail "$1 did not answer within 120 s"
}
wait_for "$API/api/health"
wait_for "$LENS/healthz"

curl -fsS -X POST "$LENS/api/reset" >/dev/null

# Five database queries: three list calls, one insert, one failing query. Login touches no database.
for _ in 1 2 3; do curl -fsS -o /dev/null "$API/api/notes"; done
curl -fsS -o /dev/null -X POST -H 'Content-Type: application/json' -d '{"text":"e2e note"}' "$API/api/notes"
curl -fsS -o /dev/null -X POST -H 'Content-Type: application/json' \
  -d '{"username":"demo","password":"demo-password"}' "$API/api/login"
status=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/fail")
[ "$status" = 500 ] || fail "GET /api/fail answered $status, expected 500"
EXPECTED=5
sent=$(python3 -I -c 'import time; print(time.time())')

count=0
for _ in $(seq 1 100); do
  count=$(curl -fsS "$LENS/api/graph" | json "next((e['count'] for e in data['edges'] if e['id'] == '$DB_EDGE'), 0)")
  [ "$count" -ge "$EXPECTED" ] && break
  sleep 0.1
done
visible=$(python3 -I -c "import time; print(round(time.time() - $sent, 2))")
[ "$count" -eq "$EXPECTED" ] || fail "$DB_EDGE has $count calls, expected $EXPECTED"

graph=$(curl -fsS "$LENS/api/graph")
kinds=$(echo "$graph" | json "sorted((n['id'], n['kind']) for n in data['nodes'])")
[ "$kinds" = "[('db:postgresql:db:5432/demo', 'database'), ('svc:demo-api', 'service')]" ] || fail "unexpected nodes: $kinds"
errors=$(echo "$graph" | json "next(e['errors'] for e in data['edges'] if e['id'] == '$DB_EDGE')")
[ "$errors" -eq 0 ] || fail "$DB_EDGE has $errors errors; sqlx query events carry none (ADR-0008)"
spans=$(curl -fsS "$LENS/api/stats" | json "data['spans_received']")
[ "$spans" -ge 11 ] || fail "collector received $spans spans, expected at least 11 (6 server + 5 database)"
csp=$(curl -fsS -o /dev/null -D - "$LENS/" | tr -d '\r' | awk -F': ' 'tolower($1) == "content-security-policy" {print $2}')
[ "$csp" = "default-src 'self'; connect-src 'self'" ] || fail "UI page sends CSP '$csp'"

python3 -I -c "import sys; sys.exit(0 if $visible <= 2.0 else 1)" || fail "edge visible after ${visible} s, budget 2 s"
echo "OK: $DB_EDGE has $count calls, visible ${visible} s after the last request; $spans spans received"
