// Core
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Domain
import { KINDS, type Kind, NOTES } from './benchRequests'
// Services
import { type Clock, runSlot, type Send } from './loadGenerator'

// Fake timers drive both the schedule and the clock, so every timing below is exact.
const clock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }
const after = (ms: number, ok = true) => new Promise<boolean>((resolve) => setTimeout(() => resolve(ok), ms))

beforeEach(() => {
  vi.useFakeTimers({ now: 0 })
})

afterEach(() => {
  vi.useRealTimers()
})

async function slot(plan: Parameters<typeof runSlot>[0], send: Send) {
  const result = runSlot(plan, send, clock)
  await vi.runAllTimersAsync()
  return result
}

describe('runSlot', () => {
  it('sends rate × seconds requests, each kind in equal parts, notes within the bench API', async () => {
    const sent: [Kind, number][] = []

    const result = await slot({ rate: 100, workers: 4, seconds: 1 }, async (kind, note) => {
      sent.push([kind, note])
      return true
    })

    expect(sent).toHaveLength(100)
    for (const kind of KINDS) expect(sent.filter(([sentKind]) => sentKind === kind)).toHaveLength(20)
    expect(sent.every(([, note]) => note >= 1 && note <= NOTES)).toBe(true)
    expect(Object.values(result.latencies).flat()).toEqual(Array(100).fill(0))
    expect(result.errors).toBe(0)
  })

  it('offsets each loop by its index, so the kinds run alongside each other', async () => {
    const first: Kind[] = []

    await slot({ rate: 40, workers: 4, seconds: 0.1 }, async (kind) => {
      first.push(kind)
      return true
    })

    expect(first).toEqual(['health', 'login', 'getNote', 'putNote'])
  })

  it('counts a request delayed by a slow answer from its scheduled start, one after a sleep from the wake-up', async () => {
    // One loop, a request every 100 ms; the first answer takes 250 ms, the others none.
    let calls = 0
    const result = await slot({ rate: 10, workers: 1, seconds: 0.5 }, () => after(calls++ === 0 ? 250 : 0))

    // Scheduled at 0, 100, 200, 300, 400 ms: the second and third start at 250 ms.
    const latencies = KINDS.map((kind) => result.latencies[kind][0])
    expect(latencies).toEqual([250, 150, 50, 0, 0])
  })

  it('counts failed and throwing requests as errors, not samples', async () => {
    let calls = 0
    const result = await slot({ rate: 10, workers: 1, seconds: 0.4 }, () => {
      calls += 1
      if (calls === 1) return Promise.resolve(false)
      if (calls === 2) return Promise.reject(new Error('connection refused'))
      if (calls === 3) throw new Error('thrown before a promise exists')
      return Promise.resolve(true)
    })

    expect(result.errors).toBe(3)
    expect(Object.values(result.latencies).flat()).toHaveLength(1)
  })
})
