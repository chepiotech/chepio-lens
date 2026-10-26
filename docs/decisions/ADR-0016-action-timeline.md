# ADR-0016: Group activity by user action, ordered by the call tree

## Status
Accepted

## Date
2026-10-26

## Context
The logs panel lists one line per stored span plus app logs and browser actions (ADR-0012). One click in the demo
gives four lines (browser fetch, action, backend request, SQL) interleaved with other activity, the way back
(database result, backend response, browser response) has no line, and the action is stamped when the SDK emits it,
after its own fetch. An action is linked only to the first fetch its handler starts. The owner wants one entry per
action that expands into the whole chain, there and back, as the process ran.

## Decision
- An activity is a user action with every fetch its handler starts synchronously, or a trace without an action, or
  an action that started nothing. Its id is `action:<lens.action.id>` or `trace:<trace_id>`.
- The web SDK gives each action a random `lens.action.id` and writes it on the action record and on every fetch span
  started in the handler's synchronous scope. The collector groups by that attribute, so the result does not depend
  on whether the spans or the action record arrive first. Without the attribute (older SDKs), an action record's
  trace id links its trace, as before. Continuations after `await` stay separate (ADR-0012).
- The action's time is the event's own timestamp, in whole milliseconds like the browser's span starts. A submit
  caused by a click on its submit button, or requested from a click handler, belongs to that click.
- Steps are derived on read from the stored spans and records: a depth-first walk of the call tree, each span's
  start step, its children and log records in that span's own clock order, then its end step. Clocks of different
  processes are never compared to order steps (I12).
- The database step shows SQL text, rows returned, rows affected, duration and error, never row contents (ADR-0008,
  ADR-0010). The clicked element is described by attributes and position only, never by page text, because free text
  is not masked (I2).
- The collector keeps a bounded activity index and serves summaries and steps through new UI API endpoints and an
  SSE event; the flat log stays available.

## Rationale
Grouping by an id carried on the spans themselves needs no time window and no guess, and survives the separate
export batches of spans and logs. Deriving steps on read keeps ingest cheap and reuses the stored, redacted data.
The call tree gives a correct order across processes with skewed clocks, which timestamps cannot.

## Alternatives considered
- Group in the UI from `/api/logs` and `/api/requests/{trace_id}`: paging and filters would cut activities apart,
  and an action with several fetches has no link to its later traces.
- Group by trace only: an action with two fetches would be two entries.
- Link by a time window after the click: guesses, and wrong under concurrency (rejected in ADR-0012).
- zone.js context propagation to follow `await`: a new dependency that patches every Promise and timer in the app.
- Capture result rows: needs a wrapper around every query (rejected in ADR-0008) and moves user data that is masked
  by key only.

## Consequences
- Contract change: `lens.action.id` and `lens.db.affected_rows` in `conventions`, new UI API endpoints and SSE event,
  documented in `docs/architecture/interfaces.md`.
- A handler that fetches after `await` produces two entries.
- One more bounded index in the collector; ingest throughput is re-measured.

## Validation
Fixture tests for grouping in every arrival order and with skewed clocks; a Playwright test in which one demo
"Delete" is one entry with its steps in order and real payloads, and a click that starts nothing is its own entry.

## Reconsider when
Apps commonly fetch after `await` in handlers and the split entries confuse users, or a browser API for async context
(such as `AsyncContext`) becomes available.
