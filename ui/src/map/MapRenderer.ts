// Types
import type { EdgeView } from '../api/generated/EdgeView'
import type { LogEntryView } from '../api/generated/LogEntryView'
import type { NodeView } from '../api/generated/NodeView'
import type { BoundaryState, MapScene, ScenePacket } from './mapScene/mapScene'
// Utils
import { formatMs } from './formatMs'
import { type Camera, distanceToCurve, edgeCurve, fitCamera, insideNode, pointOnCurve, toWorld, zoomAt } from './geometry'
import { type LucideIcon, lucideIcons } from './icons/lucideIcons'
import { NODE_HEIGHT, NODE_WIDTH, type NodeSize, type Point, layoutGraph } from './layoutGraph'
import { FLASH_MS, type Glyph, PACKET_COLORS, flashGlyph, packetName, packetPhase, requestGlyph, responseGlyph } from './packets'
import type { Pulse } from './requestPulses'
import { nodeCard, nodeKind, type NodeCard, type NodeCatalog } from './nodeCards/nodeCards'
import { drawNodeCard, loadTechnologyLogos } from './nodeCards/drawNodeCard'
import { CONNECTION_COLORS, distanceToRoute, pointOnRoute } from './mapScene/mapScene'
import { drawSceneGroup, drawSceneNode } from './mapScene/drawScene'

export type Selection = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | null

const COLORS = {
  background: '#0f1115',
  selected: '#e6e8eb',
  muted: 'rgba(230, 232, 235, 0.55)',
  edge: 'rgba(230, 232, 235, 0.28)',
  error: '#f7768e',
  pulse: '#7dcfff',
} as const

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif'
/** Bound on animated pulses; the oldest are dropped first. */
const MAX_PULSES = 400
/** Bound on log and action flashes at nodes; the oldest are dropped first. */
const MAX_FLASHES = 100
/** Packet icon size and the disc behind it, in map pixels; Lucide draws on a 24-unit grid. */
const ICON_PX = 16
const ICON_DISC_PX = 11
const BADGE_PX = 9
const CLICK_SLOP_PX = 4
const EDGE_HIT_PX = 6

type ActivePulse = Pulse & { start: number; request: Glyph | null; response: Glyph | null }
type ActiveFlash = { nodeId: string; glyph: Glyph; start: number }
type Drag = { x: number; y: number; moved: boolean }

/** Canvas 2D map outside React's render cycle (ADR-0006): React passes data in and receives selections out. */
export class MapRenderer {
  private readonly ctx: CanvasRenderingContext2D
  private camera: Camera = { x: 0, y: 0, scale: 1 }
  private nodes: NodeView[] = []
  private edges: EdgeView[] = []
  private positions = new Map<string, Point>()
  private cards = new Map<string, NodeCard>()
  private sizes = new Map<string, NodeSize>()
  private readonly logos = loadTechnologyLogos(() => { this.dirty = true })
  private pulses: ActivePulse[] = []
  private scene?: MapScene
  private scenePackets: (ScenePacket & { start: number })[] = []
  private boundaryStates: Record<string, BoundaryState> = {}
  private readonly sceneLogos = new Map<string, HTMLImageElement>()
  private flashes: ActiveFlash[] = []
  private readonly iconPaths = new Map<LucideIcon, Path2D[]>()
  private readonly reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null
  private animatedRequests = 0
  private selection: Selection = null
  private userMoved = false
  private dirty = true
  private drag: Drag | null = null
  private frame = 0
  private readonly resizeObserver: ResizeObserver

  private readonly canvas: HTMLCanvasElement
  private readonly onSelect: (selection: Selection) => void

  constructor(canvas: HTMLCanvasElement, onSelect: (selection: Selection) => void) {
    this.canvas = canvas
    this.onSelect = onSelect
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

  setGraph(nodes: NodeView[], edges: EdgeView[], catalog: NodeCatalog = {}, scene?: MapScene) {
    this.nodes = nodes
    this.edges = edges
    this.scene = scene
    this.cards = new Map(nodes.map((node) => [node.id, nodeCard(node, edges, catalog[node.id])]))
    this.sizes = new Map([...this.cards].map(([id, card]) => [id, { width: NODE_WIDTH, height: card.height }]))
    this.positions = layoutGraph(nodes, edges, this.sizes)
    if (scene) {
      this.sizes = new Map(Object.entries(scene.nodes).map(([id, node]) => [id, { width: node.width, height: node.height }]))
      this.positions = new Map(Object.entries(scene.nodes).map(([id, node]) => [id, node.position]))
      for (const item of [...Object.values(scene.nodes), ...scene.groups]) {
        if (!item.logo || this.sceneLogos.has(item.logo)) continue
        const image = new Image()
        image.onload = () => { this.dirty = true }
        image.src = item.logo
        this.sceneLogos.set(item.logo, image)
      }
    }
    this.invalidate(!this.userMoved)
  }

  setSelection(selection: Selection) {
    this.selection = selection
    this.invalidate(false)
  }

  fit() { this.userMoved = false; this.invalidate(true) }

  zoom(factor: number) {
    this.userMoved = true
    this.camera = zoomAt(this.camera, { x: this.canvas.clientWidth / 2, y: this.canvas.clientHeight / 2 }, factor)
    this.dirty = true
  }

  focusNode(id: string) {
    const point = this.positions.get(id)
    if (!point) return
    const height = this.sizes.get(id)?.height ?? NODE_HEIGHT
    const scale = Math.min(1, (this.canvas.clientWidth - 32) / (this.sizes.get(id)?.width ?? NODE_WIDTH), (this.canvas.clientHeight - 144) / height)
    this.camera = { scale: Math.max(0.25, scale), x: this.canvas.clientWidth / 2 - point.x * Math.max(0.25, scale), y: this.canvas.clientHeight / 2 - point.y * Math.max(0.25, scale) }
    this.userMoved = true
    this.dirty = true
  }

  /** Animates one request: per hop its request icon out and its response icon back, timed by `pulsesFor`. */
  pulse(pulses: Pulse[]) {
    // Exposed on the canvas for the browser end-to-end test: how many requests the map has animated, and what the
    // last one carried.
    this.canvas.dataset.animatedRequests = String(++this.animatedRequests)
    this.canvas.dataset.lastPackets = pulses.map((pulse) => packetName(pulse.packet)).join(' ')
    const now = performance.now()
    for (const pulse of pulses) {
      this.pulses.push({
        ...pulse,
        start: now + pulse.delayMs,
        request: pulse.packet && requestGlyph(pulse.packet),
        response: pulse.packet && responseGlyph(pulse.packet),
      })
    }
    if (this.pulses.length > MAX_PULSES) this.pulses.splice(0, this.pulses.length - MAX_PULSES)
  }

  /** One-way illustrative messages, independent of the live request/response packet contract. */
  playScenePacket(packet: ScenePacket) {
    if (!this.scene?.edges[packet.edgeId]) return
    this.scenePackets.push({ ...packet, start: performance.now() })
    if (this.scenePackets.length > MAX_PULSES) this.scenePackets.splice(0, this.scenePackets.length - MAX_PULSES)
    this.canvas.dataset.simulatedPackets = String(Number(this.canvas.dataset.simulatedPackets ?? 0) + 1)
    this.canvas.dataset.lastSimulatedPacket = packet.label
  }

  clearScenePackets() { this.scenePackets = []; this.dirty = true }

  setBoundaryStates(states: Record<string, BoundaryState>) { this.boundaryStates = states; this.dirty = true }

  /** Shows a log record or user action at its nodes for `FLASH_MS`; spans flash nothing (they travel as packets). */
  flash(entry: LogEntryView) {
    const glyph = flashGlyph(entry)
    if (!glyph) return
    const now = performance.now()
    for (const nodeId of entry.nodes) this.flashes.push({ nodeId, glyph, start: now })
    if (this.flashes.length > MAX_FLASHES) this.flashes.splice(0, this.flashes.length - MAX_FLASHES)
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
    if (refit) {
      const bounds = [...this.positions].map(([id, position]) => ({ ...position, ...this.sizes.get(id) }))
      if (this.scene) {
        for (const group of this.scene.groups) bounds.push({ x: group.x + group.width / 2, y: group.y + group.height / 2, width: group.width, height: group.height })
        for (const edge of Object.values(this.scene.edges)) for (const point of edge.points) bounds.push({ ...point, width: 1, height: 1 })
      }
      const topInset = this.scene ? this.canvas.clientWidth <= 600 ? 120 : 76 : 0
      this.camera = fitCamera(bounds, this.canvas.clientWidth, this.canvas.clientHeight - topInset, this.scene ? 24 : 48)
      this.camera.y += topInset
    }
    this.dirty = true
  }

  private readonly loop = (now: number) => {
    const hadAnimations = this.pulses.length > 0 || this.flashes.length > 0 || this.scenePackets.length > 0
      || (!this.reducedMotion?.matches && Object.values(this.boundaryStates).some((state) => state.status === 'waiting'))
    this.pulses = this.pulses.filter((pulse) => now - pulse.start < pulse.durationMs)
    this.scenePackets = this.scenePackets.filter((packet) => now - packet.start < packet.durationMs)
    this.flashes = this.flashes.filter((flash) => now - flash.start < FLASH_MS)
    // One more frame after the last animation ends, so its final position does not stay on the canvas.
    if (this.dirty || hadAnimations) {
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
    if (this.scene) for (const group of this.scene.groups) drawSceneGroup(ctx, group, group.logo ? this.sceneLogos.get(group.logo) : undefined)
    for (const edge of this.edges) this.drawEdge(edge)
    for (const pulse of this.pulses) this.drawPulse(pulse, now)
    for (const node of this.nodes) this.drawNode(node, now)
    for (const packet of this.scenePackets) this.drawScenePacket(packet, now)
    this.drawFlashes(now)
  }

  private curve(edge: EdgeView) {
    const from = this.positions.get(edge.from)
    const to = this.positions.get(edge.to)
    return from && to ? edgeCurve(from, to) : null
  }

  private drawEdge(edge: EdgeView) {
    const sceneEdge = this.scene?.edges[edge.id]
    if (sceneEdge) {
      const { ctx } = this
      const selected = this.selection?.kind === 'edge' && this.selection.id === edge.id
      const related = this.selection?.kind === 'node' && (this.selection.id === edge.from || this.selection.id === edge.to)
      const active = this.scenePackets.some((packet) => packet.edgeId === edge.id)
      ctx.save()
      ctx.globalAlpha = selected || related || active ? 1 : this.selection ? 0.16 : 0.5
      ctx.strokeStyle = CONNECTION_COLORS[sceneEdge.kind]
      ctx.lineWidth = selected || related || active ? 2.5 : 1.4
      ctx.lineJoin = 'round'
      ctx.setLineDash(['event', 'pubsub', 'websocket'].includes(sceneEdge.kind) ? [6, 5] : [])
      ctx.beginPath()
      sceneEdge.points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y))
      ctx.stroke()
      ctx.setLineDash([])
      const end = sceneEdge.points.at(-1)!
      const before = pointOnRoute(sceneEdge.points, 0.99)
      const angle = Math.atan2(end.y - before.y, end.x - before.x)
      ctx.fillStyle = ctx.strokeStyle
      ctx.beginPath()
      ctx.moveTo(end.x, end.y)
      ctx.lineTo(end.x - 8 * Math.cos(angle - 0.45), end.y - 8 * Math.sin(angle - 0.45))
      ctx.lineTo(end.x - 8 * Math.cos(angle + 0.45), end.y - 8 * Math.sin(angle + 0.45))
      ctx.fill()
      if (selected) {
        const center = pointOnRoute(sceneEdge.points, 0.5)
        ctx.font = `12px ${FONT}`
        ctx.textAlign = 'center'
        const width = ctx.measureText(sceneEdge.label).width + 16
        ctx.fillStyle = COLORS.background
        ctx.fillRect(center.x - width / 2, center.y - 24, width, 20)
        ctx.fillStyle = '#e6e8eb'
        ctx.fillText(sceneEdge.label, center.x, center.y - 10)
      }
      ctx.restore()
      return
    }
    const curve = this.curve(edge)
    if (!curve) return
    const { ctx } = this
    const selected = this.selection?.kind === 'edge' && this.selection.id === edge.id
    const cache = this.nodes.some((node) => node.id === edge.to && nodeKind(node) === 'cache')
    const [p0, p1, p2, p3] = curve
    ctx.strokeStyle = selected ? COLORS.selected : edge.last_error ? COLORS.error : cache ? '#b17d76' : COLORS.edge
    ctx.lineWidth = selected ? 2.5 : 1.5
    ctx.setLineDash(cache ? [5, 5] : [])
    ctx.beginPath()
    ctx.moveTo(p0.x, p0.y)
    ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y)
    ctx.stroke()
    ctx.setLineDash([])
    // Arrowhead at the target.
    ctx.fillStyle = ctx.strokeStyle
    ctx.beginPath()
    ctx.moveTo(p3.x, p3.y)
    ctx.lineTo(p3.x - 8, p3.y - 4)
    ctx.lineTo(p3.x - 8, p3.y + 4)
    ctx.closePath()
    ctx.fill()

    const middle = pointOnCurve(curve, 0.5)
    ctx.font = `11px ${FONT}`
    ctx.textAlign = 'center'
    ctx.fillStyle = edge.last_error ? COLORS.error : COLORS.muted
    const calls = `${edge.count} ${edge.count === 1 ? 'call' : 'calls'}`
    // High enough that a packet icon passing the middle does not cover it.
    ctx.fillText(`${cache ? 'CACHE' : edge.protocol.toUpperCase()} · Last ${formatMs(edge.last_duration_ms)}${edge.last_error ? ' · error' : ''}`, middle.x, middle.y - 19)
    ctx.fillText(calls, middle.x, middle.y + 24)
  }

  private drawScenePacket(packet: ScenePacket & { start: number }, now: number) {
    const edge = this.scene?.edges[packet.edgeId]
    if (!edge) return
    const progress = Math.min(1, Math.max(0, (now - packet.start) / packet.durationMs))
    const t = this.reducedMotion?.matches ? 0.5 : packet.reverse ? 1 - progress : progress
    const center = pointOnRoute(edge.points, t)
    const icon = edge.kind === 'sql' ? 'database' : edge.kind === 'event' || edge.kind === 'pubsub' || edge.kind === 'websocket' ? 'send' : edge.kind === 'auth' ? 'lock' : 'file-braces'
    this.drawGlyph({ icon, color: CONNECTION_COLORS[edge.kind], badge: null, label: packet.label }, center, 1)
  }

  private drawPulse(pulse: ActivePulse, now: number) {
    const progress = (now - pulse.start) / pulse.durationMs
    if (progress < 0 || progress > 1) return
    const edge = this.edges.find((candidate) => candidate.id === pulse.edgeId)
    const curve = edge && this.curve(edge)
    if (!curve) return
    if (!pulse.request || !pulse.response) {
      // No packet data (the caller span was evicted): the plain dot.
      const point = pointOnCurve(curve, progress)
      this.ctx.fillStyle = COLORS.pulse
      this.ctx.beginPath()
      this.ctx.arc(point.x, point.y, 4, 0, Math.PI * 2)
      this.ctx.fill()
      return
    }
    // Reduced motion: the icons do not travel; request then response sit at the middle of the edge.
    const phase = this.reducedMotion?.matches
      ? { side: progress < 0.5 ? 'request' : 'response', t: 0.5 }
      : packetPhase(progress, pulse.outbound, pulse.inbound)
    this.drawGlyph(phase.side === 'request' ? pulse.request : pulse.response, pointOnCurve(curve, phase.t), 1)
  }

  /** Log and action icons rise and fade above the top-right corner of their node, side by side when several. */
  private drawFlashes(now: number) {
    const perNode = new Map<string, number>()
    for (const flash of this.flashes) {
      const center = this.positions.get(flash.nodeId)
      if (!center) continue
      const index = perNode.get(flash.nodeId) ?? 0
      perNode.set(flash.nodeId, index + 1)
      const progress = (now - flash.start) / FLASH_MS
      const rise = this.reducedMotion?.matches ? 0 : 10 * progress
      const point = {
        x: center.x + NODE_WIDTH / 2 - 14 - (index % 6) * 34,
        y: center.y - (this.sizes.get(flash.nodeId)?.height ?? NODE_HEIGHT) / 2 - 6 - rise,
      }
      this.drawGlyph(flash.glyph, point, 1 - progress * progress)
    }
  }

  private drawGlyph(glyph: Glyph, center: Point, alpha: number) {
    const { ctx } = this
    ctx.save()
    ctx.globalAlpha = alpha
    // A disc behind the icon keeps it readable over edges and their labels.
    ctx.fillStyle = COLORS.background
    ctx.strokeStyle = glyph.color
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(center.x, center.y, ICON_DISC_PX, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    this.strokeIcon(glyph.icon, center.x - ICON_PX / 2, center.y - ICON_PX / 2, ICON_PX, glyph.color)
    if (glyph.badge) {
      ctx.fillStyle = COLORS.background
      ctx.beginPath()
      ctx.arc(center.x + 7, center.y + 6, BADGE_PX / 2 + 1.5, 0, Math.PI * 2)
      ctx.fill()
      this.strokeIcon(glyph.badge, center.x + 7 - BADGE_PX / 2, center.y + 6 - BADGE_PX / 2, BADGE_PX, PACKET_COLORS.badge)
    }
    if (glyph.label) {
      ctx.font = `600 9px ${FONT}`
      ctx.textAlign = 'center'
      ctx.fillStyle = glyph.color
      ctx.fillText(glyph.label, center.x, center.y + ICON_DISC_PX + 10)
    }
    ctx.restore()
  }

  /** A Lucide icon: round 2-unit strokes on a 24-unit grid, scaled to `size` pixels at (`x`, `y`). */
  private strokeIcon(icon: LucideIcon, x: number, y: number, size: number, color: string) {
    let paths = this.iconPaths.get(icon)
    if (!paths) {
      paths = lucideIcons[icon].map((data) => new Path2D(data))
      this.iconPaths.set(icon, paths)
    }
    const { ctx } = this
    ctx.save()
    ctx.translate(x, y)
    ctx.scale(size / 24, size / 24)
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const path of paths) ctx.stroke(path)
    ctx.restore()
  }

  private drawNode(node: NodeView, now: number) {
    const sceneNode = this.scene?.nodes[node.id]
    if (sceneNode) {
      drawSceneNode(this.ctx, node, sceneNode, this.selection?.kind === 'node' && this.selection.id === node.id,
        sceneNode.logo ? this.sceneLogos.get(sceneNode.logo) : undefined,
        this.boundaryStates[node.id], now, this.reducedMotion?.matches ?? false)
      return
    }
    const center = this.positions.get(node.id)
    const card = this.cards.get(node.id)
    if (!center || !card) return
    drawNodeCard(this.ctx, node, card, center, this.selection?.kind === 'node' && this.selection.id === node.id,
      this.logos, this.camera.scale < 0.45)
  }

  private hitTest(screen: Point): Selection {
    const world = toWorld(this.camera, screen)
    for (const node of [...this.nodes].reverse()) {
      const center = this.positions.get(node.id)
      if (center && insideNode(center, world, this.sizes.get(node.id))) return { kind: 'node', id: node.id }
    }
    for (const edge of this.edges) {
      const route = this.scene?.edges[edge.id]
      if (route && distanceToRoute(route.points, world) <= EDGE_HIT_PX / this.camera.scale) return { kind: 'edge', id: edge.id }
      if (route) continue
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
