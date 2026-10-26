// Core
import { describe, expect, it } from 'vitest'
// Utils
import { distanceToRoute, pointOnRoute } from './mapScene'

describe('architecture routes', () => {
  const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 90 }]
  it('moves by distance, clamps progress and tolerates repeated points', () => {
    expect(pointOnRoute(points, 0.5)).toEqual({ x: 10, y: 40 })
    expect(pointOnRoute(points, -1)).toEqual(points[0])
    expect(pointOnRoute(points, 2)).toEqual(points[2])
    expect(pointOnRoute([{ x: 1, y: 1 }, { x: 1, y: 1 }], 0.5)).toEqual({ x: 1, y: 1 })
  })
  it('hits elbows and short segments without depending on sampling density', () => {
    expect(distanceToRoute(points, { x: 5, y: 3 })).toBe(3)
    expect(distanceToRoute(points, { x: 10, y: 0 })).toBe(0)
    expect(distanceToRoute(points, { x: 14, y: 94 })).toBeCloseTo(Math.sqrt(32))
  })
})
