// Core
import { describe, expect, it } from 'vitest'
// Domain
import { KINDS } from './benchRequests'
// Services
import { emptyLatencies } from './loadGenerator'
// Utils
import {
  deltaOverRounds,
  latencyQuantile,
  median,
  overRounds,
  quantile,
  report,
  type Round,
  type SlotStats,
  taskMsPerRequest,
} from './overheadStats'

function slot(health: number[], options: Partial<SlotStats> = {}): SlotStats {
  return { latencies: { ...emptyLatencies(), health }, errors: 0, taskMs: 0, longTasks: 0, ...options }
}

describe('quantile', () => {
  it('takes the nearest rank, as the Rust bench does', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

    expect(quantile(values, 0.5)).toBe(5)
    expect(quantile(values, 0.95)).toBe(10)
    expect(quantile(values, 0)).toBe(1)
    expect(quantile([], 0.5)).toBeNaN()
  })
})

describe('median', () => {
  it('ignores NaN and averages the middle pair', () => {
    expect(median([3, Number.NaN, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([Number.NaN])).toBeNaN()
  })
})

describe('statistics over rounds', () => {
  // Round 2 stalls the whole machine during the off slot; the per-round difference keeps the stall out.
  const rounds: Round[] = [
    { off: slot([1, 1, 1, 2]), bodies: slot([1.25, 1.25, 1.25, 2.5], { taskMs: 8 }) },
    { off: slot([30, 30, 30, 40]), bodies: slot([1.5, 1.5, 1.5, 2.25], { taskMs: 4, errors: 4 }) },
    { off: slot([1, 1, 1, 2]), bodies: slot([1, 1, 1, 3], { taskMs: 2 }) },
  ]

  it('takes the median over the rounds of each round’s quantile', () => {
    expect(overRounds(rounds, 'off', latencyQuantile(KINDS, 0.5))).toBe(1)
    expect(overRounds(rounds, 'bodies', latencyQuantile(['health'], 0.95))).toBe(2.5)
  })

  it('takes differences within each round before the median', () => {
    // Per round: +0.25, −28.5, 0 at p50.
    expect(deltaOverRounds(rounds, 'bodies', 'off', latencyQuantile(KINDS, 0.5))).toBe(0)
    // Per round: +0.5, −37.75, +1 at p95.
    expect(deltaOverRounds(rounds, 'bodies', 'off', latencyQuantile(KINDS, 0.95))).toBe(0.5)
  })

  it('divides main-thread time by every request sent, failed ones included', () => {
    expect(taskMsPerRequest(rounds[0] ?? {}, 'bodies')).toBe(2)
    expect(taskMsPerRequest(rounds[1] ?? {}, 'bodies')).toBe(0.5)
    expect(taskMsPerRequest({}, 'bodies')).toBeNaN()
  })

  it('reports every mode with its differences to off', () => {
    const text = report(rounds, ['off', 'bodies'], { rate: 100, workers: 4, seconds: 10 })

    expect(text).toContain('100 req/s per mode from 4 loops, 3 rounds of 10 s per mode')
    expect(text).toMatch(/^bodies\s+12\s+4\s+1\.25\s+2\.50\s+2\.50\s+\+0\.00\s+\+0\.50\s+\+0\.50\s+3\.00\s+0\.50/m)
    expect(text).toMatch(/^GET \/bench-api\/health\s+1\.00 \/ 2\.00\s+1\.25 \/ 2\.50$/m)
    expect(text).toMatch(/^GET \/bench-api\/health\s+\+0\.00 \/ \+0\.00\s+\+0\.00 \/ \+0\.50$/m)
    expect(text).toMatch(/^round 2\s+40\.00\s+2\.25$/m)
  })
})
