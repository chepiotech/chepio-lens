// Utils
import { NODE_HEIGHT, NODE_WIDTH, type NodeSize, type Point } from './layoutGraph'

export type Camera = { x: number; y: number; scale: number }

export const MIN_SCALE = 0.01
export const MAX_SCALE = 3

export function toWorld(camera: Camera, screen: Point): Point {
  return { x: (screen.x - camera.x) / camera.scale, y: (screen.y - camera.y) / camera.scale }
}

export function toScreen(camera: Camera, world: Point): Point {
  return { x: world.x * camera.scale + camera.x, y: world.y * camera.scale + camera.y }
}

/** Zooms by `factor` keeping the world point under `anchor` (screen coordinates) still. */
export function zoomAt(camera: Camera, anchor: Point, factor: number): Camera {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, camera.scale * factor))
  const world = toWorld(camera, anchor)
  return { scale, x: anchor.x - world.x * scale, y: anchor.y - world.y * scale }
}

/** Camera that shows every point with `padding` screen pixels around, never zooming in past 1:1. */
export function fitCamera(points: (Point & Partial<NodeSize>)[], width: number, height: number, padding = 48): Camera {
  if (points.length === 0) return { x: width / 2, y: height / 2, scale: 1 }
  const minX = Math.min(...points.map((p) => p.x - (p.width ?? NODE_WIDTH) / 2))
  const maxX = Math.max(...points.map((p) => p.x + (p.width ?? NODE_WIDTH) / 2))
  const minY = Math.min(...points.map((p) => p.y - (p.height ?? NODE_HEIGHT) / 2))
  const maxY = Math.max(...points.map((p) => p.y + (p.height ?? NODE_HEIGHT) / 2))
  const scale = Math.min(
    1,
    Math.max(MIN_SCALE, Math.min((width - 2 * padding) / (maxX - minX), (height - 2 * padding) / (maxY - minY))),
  )
  return {
    scale,
    x: width / 2 - ((minX + maxX) / 2) * scale,
    y: height / 2 - ((minY + maxY) / 2) * scale,
  }
}

export function insideNode(center: Point, point: Point, size: NodeSize = { width: NODE_WIDTH, height: NODE_HEIGHT }): boolean {
  return Math.abs(point.x - center.x) <= size.width / 2 && Math.abs(point.y - center.y) <= size.height / 2
}

/** Cubic curve from the right side of `from` to the left side of `to`; control points keep it horizontal at both ends. */
export function edgeCurve(from: Point, to: Point): [Point, Point, Point, Point] {
  const start = { x: from.x + NODE_WIDTH / 2, y: from.y }
  const end = { x: to.x - NODE_WIDTH / 2, y: to.y }
  const bend = Math.max(40, Math.abs(end.x - start.x) / 2)
  return [start, { x: start.x + bend, y: start.y }, { x: end.x - bend, y: end.y }, end]
}

export function pointOnCurve([p0, p1, p2, p3]: [Point, Point, Point, Point], t: number): Point {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y }
}

/** Distance from `point` to the curve, sampled; good enough for clicking. */
export function distanceToCurve(curve: [Point, Point, Point, Point], point: Point, samples = 32): number {
  let best = Infinity
  for (let i = 0; i <= samples; i++) {
    const p = pointOnCurve(curve, i / samples)
    best = Math.min(best, Math.hypot(p.x - point.x, p.y - point.y))
  }
  return best
}
