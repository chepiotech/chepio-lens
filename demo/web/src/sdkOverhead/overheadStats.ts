// Statistics of the web SDK overhead bench, computed as the Rust bench does: every statistic per round, summarized by
// its median over the rounds. A difference to `off` is taken within each round, where the modes ran one after
// another, before the median, so a stall of the machine during one slot moves no result.

// Domain
import { KIND_LABELS, KINDS, type Kind } from './benchRequests'
import type { Mode } from './benchModes'
// Types
import type { Latencies, Plan } from './loadGenerator'

export type SlotStats = {
  latencies: Latencies
  errors: number
  /** Main-thread task time during the slot (Chromium's `TaskDuration`), in ms. */
  taskMs: number
  longTasks: number
}
export type Round = Partial<Record<Mode, SlotStats>>
/** One number per round and mode; NaN when the round has no such slot or no request in it. */
export type Statistic = (round: Round, mode: Mode) => number

/** Nearest-rank quantile of sorted values; NaN if there are none. */
export function quantile(sorted: readonly number[], q: number): number {
  const rank = Math.min(Math.max(Math.ceil(q * sorted.length), 1), sorted.length)
  return sorted[rank - 1] ?? Number.NaN
}

/** Median, ignoring NaN; NaN if nothing is left. */
export function median(values: readonly number[]): number {
  const sorted = values.filter((value) => !Number.isNaN(value)).sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? Number.NaN
  return ((sorted[middle - 1] ?? Number.NaN) + (sorted[middle] ?? Number.NaN)) / 2
}

/** Successful and failed requests of a slot. */
export function requestCount(slot: SlotStats): number {
  return KINDS.reduce((count, kind) => count + slot.latencies[kind].length, slot.errors)
}

/** Quantile `q` of the latencies of `kinds` in the slot of `mode`. */
export function latencyQuantile(kinds: readonly Kind[], q: number): Statistic {
  return (round, mode) => {
    const slot = round[mode]
    if (!slot) return Number.NaN
    return quantile(kinds.flatMap((kind) => slot.latencies[kind]).sort((a, b) => a - b), q)
  }
}

/** Main-thread time per request, in ms. */
export const taskMsPerRequest: Statistic = (round, mode) => {
  const slot = round[mode]
  return slot && requestCount(slot) > 0 ? slot.taskMs / requestCount(slot) : Number.NaN
}

export function overRounds(rounds: readonly Round[], mode: Mode, statistic: Statistic): number {
  return median(rounds.map((round) => statistic(round, mode)))
}

/** Median over the rounds of the difference between `mode` and `base` within each round. */
export function deltaOverRounds(rounds: readonly Round[], mode: Mode, base: Mode, statistic: Statistic): number {
  return median(rounds.map((round) => statistic(round, mode) - statistic(round, base)))
}

function total(rounds: readonly Round[], mode: Mode, value: (slot: SlotStats) => number): number {
  return rounds.reduce((sum, round) => sum + (round[mode] ? value(round[mode]) : 0), 0)
}

const ms = (value: number) => (Number.isNaN(value) ? '-' : value.toFixed(2))
const signedMs = (value: number) => (Number.isNaN(value) ? '-' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}`)
const row = (cells: string[], widths: number[]) =>
  cells.map((cell, index) => (index === 0 ? cell.padEnd(widths[0] ?? 0) : cell.padStart(widths[index] ?? 0))).join(' ')

/** The bench's text report, laid out like the Rust bench's. Differences need `off` among the modes. */
export function report(rounds: readonly Round[], modes: readonly Mode[], plan: Plan): string {
  const base: Mode | null = modes.includes('off') ? 'off' : null
  const delta = (mode: Mode, statistic: Statistic) =>
    base ? signedMs(deltaOverRounds(rounds, mode, base, statistic)) : '-'
  const lines = [
    `${plan.rate} req/s per mode from ${plan.workers} loops, ${rounds.length} rounds of ${plan.seconds} s per mode, ` +
      `${KINDS.length} request kinds in equal parts`,
    "Median over rounds of each round's quantile; Δ: median of the per-round difference to off; " +
      'main: main-thread task time per request',
    '',
  ]
  const widths = [12, 8, 6, 7, 7, 7, 7, 7, 7, 8, 8, 7, 10]
  lines.push(
    row(
      ['mode', 'requests', 'errors', 'p50 ms', 'p95 ms', 'p99 ms', 'Δp50', 'Δp95', 'Δp99', 'max ms', 'main ms', 'Δmain', 'long tasks'],
      widths,
    ),
  )
  for (const mode of modes) {
    const all = rounds.flatMap((round) => KINDS.flatMap((kind) => round[mode]?.latencies[kind] ?? []))
    const quantiles = [0.5, 0.95, 0.99].map((q) => latencyQuantile(KINDS, q))
    lines.push(
      row(
        [
          mode,
          String(all.length),
          String(total(rounds, mode, (slot) => slot.errors)),
          ...quantiles.map((statistic) => ms(overRounds(rounds, mode, statistic))),
          ...quantiles.map((statistic) => delta(mode, statistic)),
          ms(all.length === 0 ? Number.NaN : all.reduce((max, value) => Math.max(max, value), -Infinity)),
          ms(overRounds(rounds, mode, taskMsPerRequest)),
          delta(mode, taskMsPerRequest),
          String(total(rounds, mode, (slot) => slot.longTasks)),
        ],
        widths,
      ),
    )
  }
  const table = (title: string, cell: (kind: Kind, mode: Mode) => string) => {
    lines.push('', row([title, ...modes], [30, ...modes.map(() => 15)]))
    for (const kind of KINDS) {
      lines.push(row([KIND_LABELS[kind], ...modes.map((mode) => cell(kind, mode))], [30, ...modes.map(() => 15)]))
    }
  }
  const p50 = (kind: Kind) => latencyQuantile([kind], 0.5)
  const p95 = (kind: Kind) => latencyQuantile([kind], 0.95)
  table('p50 / p95 ms by request', (kind, mode) =>
    `${ms(overRounds(rounds, mode, p50(kind)))} / ${ms(overRounds(rounds, mode, p95(kind)))}`,
  )
  if (base) table('Δp50 / Δp95 ms', (kind, mode) => `${delta(mode, p50(kind))} / ${delta(mode, p95(kind))}`)
  lines.push('', row(['p95 ms per round', ...modes], [30, ...modes.map(() => 15)]))
  rounds.forEach((round, index) => {
    const cells = modes.map((mode) => ms(latencyQuantile(KINDS, 0.95)(round, mode)))
    lines.push(row([`round ${index + 1}`, ...cells], [30, ...modes.map(() => 15)]))
  })
  return lines.join('\n')
}
