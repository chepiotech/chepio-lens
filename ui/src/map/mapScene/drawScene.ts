// Types
import type { BoundaryState, SceneGroup, SceneNode } from './mapScene'
import type { NodeView } from '../../api/generated/NodeView'
// Utils
import { drawNodeCard } from '../nodeCards/drawNodeCard'

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif'

export function drawSceneGroup(ctx: CanvasRenderingContext2D, group: SceneGroup, logo?: HTMLImageElement) {
  ctx.save()
  ctx.fillStyle = 'rgba(142, 164, 196, 0.025)'
  ctx.strokeStyle = 'rgba(142, 164, 196, 0.24)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(group.x, group.y, group.width, group.height, 16)
  ctx.fill()
  ctx.stroke()
  ctx.textAlign = 'left'
  ctx.font = `600 13px ${FONT}`
  ctx.fillStyle = '#aab7ca'
  if (logo?.complete && logo.naturalWidth) ctx.drawImage(logo, group.x + 14, group.y + 7, 22, 22)
  ctx.fillText(group.label, group.x + (logo ? 44 : 16), group.y + 23)
  ctx.textAlign = 'right'
  ctx.font = `11px ${FONT}`
  ctx.fillStyle = '#9ba7b9'
  ctx.fillText(group.note, group.x + group.width - 16, group.y + 23)
  ctx.restore()
}

export function drawSceneNode(ctx: CanvasRenderingContext2D, node: NodeView, scene: SceneNode, selected: boolean,
  logo?: HTMLImageElement, boundary?: BoundaryState, now = 0, reducedMotion = false) {
  const card = boundary ? { ...scene.card,
    empty: boundary.status === 'waiting' ? 'Waiting for response…' : `Received: ${boundary.label}`,
  } : scene.card
  const logos = new Map(logo ? [[card.technologies[0]!, logo]] : [])
  drawNodeCard(ctx, node, card, scene.position, selected, logos, false)
  if (boundary?.status === 'waiting') {
    ctx.save()
    const angle = reducedMotion ? -Math.PI / 2 : now / 180
    ctx.strokeStyle = '#d6bded'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(scene.position.x + scene.width / 2 - 28, scene.position.y + scene.height / 2 - 48, 6, angle, angle + Math.PI * 1.45)
    ctx.stroke()
    ctx.restore()
  }
}
