// Core
import { describe, expect, it } from 'vitest'
// Utils
import { MIN_SCALE, distanceToCurve, edgeCurve, fitCamera, insideNode, pointOnCurve, toScreen, toWorld, zoomAt } from './geometry'
import { NODE_HEIGHT, NODE_WIDTH } from './layoutGraph'

describe('geometry', () => {
  it('converts between screen and world coordinates', () => {
    const camera = { x: 100, y: 50, scale: 2 }
    expect(toWorld(camera, { x: 120, y: 70 })).toEqual({ x: 10, y: 10 })
    expect(toScreen(camera, { x: 10, y: 10 })).toEqual({ x: 120, y: 70 })
  })

  it('zooms around the anchor and clamps the scale', () => {
    const camera = { x: 0, y: 0, scale: 1 }
    const anchor = { x: 200, y: 100 }
    const zoomed = zoomAt(camera, anchor, 2)
    expect(toWorld(zoomed, anchor)).toEqual(toWorld(camera, anchor))
    expect(zoomAt(camera, anchor, 100).scale).toBe(3)
    expect(zoomAt(camera, anchor, 0.001).scale).toBe(MIN_SCALE)
  })

  it('fits all nodes without zooming in past 1:1', () => {
    const camera = fitCamera([{ x: 0, y: 0 }], 800, 600)
    expect(camera).toEqual({ x: 400, y: 300, scale: 1 })
    const wide = fitCamera([{ x: -2000, y: 0 }, { x: 2000, y: 0 }], 800, 600)
    expect(wide.scale).toBeLessThan(1)
  })

  it('hit-tests nodes and edges', () => {
    expect(insideNode({ x: 0, y: 0 }, { x: 80, y: 20 })).toBe(true)
    expect(insideNode({ x: 0, y: 0 }, { x: NODE_WIDTH / 2 + 1, y: 0 })).toBe(false)
    expect(insideNode({ x: 0, y: 0 }, { x: 0, y: NODE_HEIGHT / 2 })).toBe(true)
    expect(insideNode({ x: 0, y: 0 }, { x: 0, y: NODE_HEIGHT / 2 + 1 })).toBe(false)
    const curve = edgeCurve({ x: 0, y: 0 }, { x: 400, y: 0 })
    expect(pointOnCurve(curve, 0)).toEqual({ x: NODE_WIDTH / 2, y: 0 })
    expect(pointOnCurve(curve, 1)).toEqual({ x: 400 - NODE_WIDTH / 2, y: 0 })
    expect(distanceToCurve(curve, { x: 200, y: 3 })).toBeLessThan(4)
    expect(distanceToCurve(curve, { x: 200, y: 60 })).toBeGreaterThan(50)
  })

  it('fits an expanded graph without clipping the first or last container', () => {
    const points = Array.from({ length: 50 }, (_, index) => ({ x: 0, y: index * 460, width: NODE_WIDTH, height: 420 }))
    const camera = fitCamera(points, 1440, 900)
    expect(toScreen(camera, { x: 0, y: -210 }).y).toBeGreaterThanOrEqual(47)
    expect(toScreen(camera, { x: 0, y: points.at(-1)!.y + 210 }).y).toBeLessThanOrEqual(853)
  })
})
