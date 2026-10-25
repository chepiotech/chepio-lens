// Types
import type { EdgeView } from '../api/generated/EdgeView'
import type { NodeView } from '../api/generated/NodeView'
// Utils
import { formatMs } from './formatMs'
import { type Camera, distanceToCurve, edgeCurve, fitCamera, insideNode, pointOnCurve, toWorld, zoomAt } from './geometry'
import { NODE_HEIGHT, NODE_WIDTH, type Point, layoutGraph } from './layoutGraph'
import type { Pulse } from './requestPulses'

export type Selection = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | null

const COLORS = {
  background: '#0f1115',
  grid: 'rgba(255, 255, 255, 0.03)',
  node: '#1a1d24',
  nodeBorder: 'rgba(255, 255, 255, 0.12)',
  selected: '#e6e8eb',
  text: '#e6e8eb',
  muted: 'rgba(230, 232, 235, 0.55)',
  edge: 'rgba(230, 232, 235, 0.28)',
  error: '#f7768e',
  pulse: '#7dcfff',
  kind: { frontend: '#7aa2f7', service: '#9ece6a', database: '#e0af68', external: '#a9b1d6' },
} as const

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif'
/** Bound on animated pulses; the oldest are dropped first. */
const MAX_PULSES = 400
const CLICK_SLOP_PX = 4
const EDGE_HIT_PX = 6

type ActivePulse = { edgeId: string; start: number; durationMs: number }
type Drag = { x: number; y: number; moved: boolean }

/** Canvas 2D map outside React's render cycle (ADR-0006): React passes data in and receives selections out. */
export class MapRenderer {
  private readonly ctx: CanvasRenderingContext2D
  private camera: Camera = { x: 0, y: 0, scale: 1 }
  private nodes: NodeView[] = []
  private edges: EdgeView[] = []
  private positions = new Map<string, Point>()
  private pulses: ActivePulse[] = []
  private animatedRequests = 0
  private selection: Selection = null
  private userMoved = false
  private dirty = true
  private drag: Drag | null = null
  private frame = 0
  private readonly resizeObserver: ResizeObserver

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onSelect: (selection: Selection) => void,
  ) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D is not available')
    this.ctx = ctx
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('dblclick', this.onDoubleClick)
    this.resizeObserver = new ResizeObserver(() => this.invalidate(true))
    this.resizeObserver.observe(canvas)
    this.frame = requestAnimationFrame(this.loop)
  }

  setGraph(nodes: NodeView[], edges: EdgeView[]) {
    this.nodes = nodes
    this.edges = edges
    this.positions = layoutGraph(nodes, edges)
    this.invalidate(!this.userMoved)
  }

  setSelection(selection: Selection) {
    this.selection = selection
    this.invalidate(false)
  }

  /** Animates one request: a dot per hop, timed by `pulsesFor`. */
  pulse(pulses: Pulse[]) {
    // Exposed on the canvas for the browser end-to-end test: how many requests the map has animated.
    this.canvas.dataset.animatedRequests = String(++this.animatedRequests)
    const now = performance.now()
    for (const { edgeId, delayMs, durationMs } of pulses) this.pulses.push({ edgeId, start: now + delayMs, durationMs })
    if (this.pulses.length > MAX_PULSES) this.pulses.splice(0, this.pulses.length - MAX_PULSES)
  }

  destroy() {
    cancelAnimationFrame(this.frame)
    this.resizeObserver.disconnect()
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('dblclick', this.onDoubleClick)
  }

  private invalidate(refit: boolean) {
    if (refit) this.camera = fitCamera([...this.positions.values()], this.canvas.clientWidth, this.canvas.clientHeight)
    this.dirty = true
  }

  private readonly loop = (now: number) => {
    const hadPulses = this.pulses.length > 0
    this.pulses = this.pulses.filter((pulse) => now - pulse.start < pulse.durationMs)
    // One more frame after the last pulse ends, so its final position does not stay on the canvas.
    if (this.dirty || hadPulses) {
      this.draw(now)
      this.dirty = false
    }
    this.frame = requestAnimationFrame(this.loop)
  }

  private draw(now: number) {
    const { ctx, canvas, camera } = this
    const ratio = window.devicePixelRatio || 1
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.fillStyle = COLORS.background
    ctx.fillRect(0, 0, width, height)

    if (this.nodes.length === 0) {
      ctx.fillStyle = COLORS.muted
      ctx.font = `14px ${FONT}`
      ctx.textAlign = 'center'
      ctx.fillText('Waiting for spans. Point CHEPIO_LENS_ENDPOINT at http://localhost:4318.', width / 2, height / 2)
      return
    }

    ctx.setTransform(ratio * camera.scale, 0, 0, ratio * camera.scale, ratio * camera.x, ratio * camera.y)
    for (const edge of this.edges) this.drawEdge(edge)
    for (const pulse of this.pulses) this.drawPulse(pulse, now)
    for (const node of this.nodes) this.drawNode(node)
  }

  private curve(edge: EdgeView) {
    const from = this.positions.get(edge.from)
    const to = this.positions.get(edge.to)
    return from && to ? edgeCurve(from, to) : null
  }

  private drawEdge(edge: EdgeView) {
    const curve = this.curve(edge)
    if (!curve) return
    const { ctx } = this
    const selected = this.selection?.kind === 'edge' && this.selection.id === edge.id
    const [p0, p1, p2, p3] = curve
    ctx.strokeStyle = selected ? COLORS.selected : edge.errors > 0 ? COLORS.error : COLORS.edge
    ctx.lineWidth = selected ? 2.5 : 1.5
    ctx.beginPath()
    ctx.moveTo(p0.x, p0.y)
    ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y)
    ctx.stroke()
    // Arrowhead at the target.
    ctx.fillStyle = ctx.strokeStyle
    ctx.beginPath()
    ctx.moveTo(p3.x, p3.y)
    ctx.lineTo(p3.x - 8, p3.y - 4)
    ctx.lineTo(p3.x - 8, p3.y + 4)
    ctx.closePath()
    ctx.fill()

    const middle = pointOnCurve(curve, 0.5)
    const errors = edge.errors > 0 ? ` · ${edge.errors} err` : ''
    ctx.font = `11px ${FONT}`
    ctx.textAlign = 'center'
    ctx.fillStyle = edge.errors > 0 ? COLORS.error : COLORS.muted
    ctx.fillText(`${edge.count} · p95 ${formatMs(edge.p95_ms)}${errors}`, middle.x, middle.y - 8)
  }

  private drawPulse(pulse: ActivePulse, now: number) {
    const progress = (now - pulse.start) / pulse.durationMs
    if (progress < 0 || progress > 1) return
    const edge = this.edges.find((candidate) => candidate.id === pulse.edgeId)
    const curve = edge && this.curve(edge)
    if (!curve) return
    const point = pointOnCurve(curve, progress)
    this.ctx.fillStyle = COLORS.pulse
    this.ctx.beginPath()
    this.ctx.arc(point.x, point.y, 4, 0, Math.PI * 2)
    this.ctx.fill()
  }

  private drawNode(node: NodeView) {
    const center = this.positions.get(node.id)
    if (!center) return
    const { ctx } = this
    const x = center.x - NODE_WIDTH / 2
    const y = center.y - NODE_HEIGHT / 2
    const selected = this.selection?.kind === 'node' && this.selection.id === node.id
    ctx.fillStyle = COLORS.node
    ctx.strokeStyle = selected ? COLORS.selected : COLORS.nodeBorder
    ctx.lineWidth = selected ? 2 : 1
    ctx.beginPath()
    ctx.roundRect(x, y, NODE_WIDTH, NODE_HEIGHT, 8)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = COLORS.kind[node.kind]
    ctx.beginPath()
    ctx.roundRect(x, y, 4, NODE_HEIGHT, [8, 0, 0, 8])
    ctx.fill()

    ctx.textAlign = 'left'
    ctx.fillStyle = COLORS.text
    ctx.font = `600 13px ${FONT}`
    ctx.fillText(fit(ctx, node.label, NODE_WIDTH - 28), x + 16, y + 24)
    ctx.fillStyle = COLORS.muted
    ctx.font = `11px ${FONT}`
    ctx.fillText(fit(ctx, subtitle(node), NODE_WIDTH - 28), x + 16, y + 41)
  }

  private hitTest(screen: Point): Selection {
    const world = toWorld(this.camera, screen)
    for (const node of [...this.nodes].reverse()) {
      const center = this.positions.get(node.id)
      if (center && insideNode(center, world)) return { kind: 'node', id: node.id }
    }
    for (const edge of this.edges) {
      const curve = this.curve(edge)
      if (curve && distanceToCurve(curve, world) <= EDGE_HIT_PX / this.camera.scale) return { kind: 'edge', id: edge.id }
    }
    return null
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    this.drag = { x: event.offsetX, y: event.offsetY, moved: false }
    this.canvas.setPointerCapture(event.pointerId)
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    const drag = this.drag
    if (!drag) return
    const dx = event.offsetX - drag.x
    const dy = event.offsetY - drag.y
    if (!drag.moved && Math.hypot(dx, dy) < CLICK_SLOP_PX) return
    drag.moved = true
    this.userMoved = true
    this.camera = { ...this.camera, x: this.camera.x + dx, y: this.camera.y + dy }
    drag.x = event.offsetX
    drag.y = event.offsetY
    this.dirty = true
  }

  private readonly onPointerUp = (event: PointerEvent) => {
    const drag = this.drag
    this.drag = null
    if (drag && !drag.moved) this.onSelect(this.hitTest({ x: event.offsetX, y: event.offsetY }))
  }

  private readonly onWheel = (event: WheelEvent) => {
    event.preventDefault()
    this.userMoved = true
    this.camera = zoomAt(this.camera, { x: event.offsetX, y: event.offsetY }, Math.exp(-event.deltaY * 0.0015))
    this.dirty = true
  }

  private readonly onDoubleClick = () => {
    this.userMoved = false
    this.invalidate(true)
  }
}

function subtitle(node: NodeView): string {
  switch (node.kind) {
    case 'database':
      return [node.address, node.port].filter((part) => part !== null).join(':') || 'database'
    case 'external':
      return 'external'
    default:
      return node.kind
  }
}

/** Cuts `text` with an ellipsis to fit `width` pixels in the current font. */
function fit(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text
  let end = text.length
  while (end > 0 && ctx.measureText(`${text.slice(0, end)}…`).width > width) end--
  return `${text.slice(0, end)}…`
}
