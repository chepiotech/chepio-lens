// Types
import type { NodeView } from '../../api/generated/NodeView'
import type { Point } from '../layoutGraph'
import type { NodeCard, Technology } from './nodeCards'
// Utils
import { NODE_WIDTH } from '../layoutGraph'
import { CARD_ROWS, technologyLabel, microfrontendHeight } from './nodeCards'
import { lucideIcons } from '../icons/lucideIcons'

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif'
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const PALETTE = {
  frontend: { accent: '#8bb9ff', surface: '#161e2c', border: '#354961' },
  service: { accent: '#b4cea2', surface: '#1b211f', border: '#3f4c42' },
  database: { accent: '#a9c9ec', surface: '#19212a', border: '#3b4b5c' },
  cache: { accent: '#ffa497', surface: '#281e21', border: '#64413f' },
  external: { accent: '#c3b6e6', surface: '#211f2b', border: '#4e465e' },
} as const
const LOGO_URLS: Record<string, string> = {
  react: new URL('./logos/react/react.svg', import.meta.url).href,
  vue: new URL('./logos/vue/vue.svg', import.meta.url).href,
  angular: new URL('./logos/angular/angular.svg', import.meta.url).href,
  rust: new URL('./logos/rust/rust.svg', import.meta.url).href,
  postgresql: new URL('./logos/postgresql/postgresql.svg', import.meta.url).href,
  redis: new URL('./logos/redis/redis.svg', import.meta.url).href,
}

export function loadTechnologyLogos(invalidate: () => void): Map<Technology, HTMLImageElement> {
  const images = new Map<Technology, HTMLImageElement>()
  for (const [name, url] of Object.entries(LOGO_URLS)) {
    const image = new Image()
    image.onload = invalidate
    image.src = url
    images.set(name as Technology, image)
  }
  return images
}

export function fitText(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (ctx.measureText(`${text.slice(0, middle)}…`).width <= width) low = middle
    else high = middle - 1
  }
  return `${text.slice(0, low)}…`
}

/** Layout, edges, hit-testing and drawing share the computed container footprint. */
export function drawNodeCard(ctx: CanvasRenderingContext2D, node: NodeView, card: NodeCard, center: Point,
  selected: boolean, logos: Map<Technology, HTMLImageElement>, compact: boolean) {
  const x = center.x - NODE_WIDTH / 2
  const y = center.y - card.height / 2
  const palette = PALETTE[card.kind]
  ctx.save()
  ctx.translate(x, y)
  ctx.fillStyle = palette.surface
  ctx.strokeStyle = selected ? '#ecf2fb' : palette.border
  ctx.lineWidth = selected ? 2 : 1
  ctx.beginPath()
  ctx.roundRect(0, 0, NODE_WIDTH, card.height, 14)
  ctx.fill()
  ctx.stroke()

  // A browser title bar distinguishes the frontend even without its colour or logo.
  if (card.kind === 'frontend') {
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = ['#bc7c78', '#c4a769', '#7fa58b'][i]!
      ctx.beginPath(); ctx.arc(18 + i * 13, 17, 3, 0, Math.PI * 2); ctx.fill()
    }
    ctx.fillStyle = '#b0bfd4'
    ctx.font = `11px ${FONT}`
    ctx.textAlign = 'right'
    ctx.fillText('Browser', NODE_WIDTH - 18, 21)
    line(ctx, 0, 34, NODE_WIDTH, palette.border)
  } else {
    ctx.fillStyle = palette.accent
    ctx.font = `500 11px ${FONT}`
    ctx.textAlign = 'left'
    ctx.fillText(card.role, 18, 23)
    ctx.textAlign = 'right'
    ctx.fillStyle = '#aab2c0'
    ctx.fillText(card.kind === 'cache' ? 'Key / value' : card.kind === 'database' ? 'Storage' : 'Service', NODE_WIDTH - 18, 23)
    line(ctx, 0, 34, NODE_WIDTH, palette.border)
  }

  const techExtra = Math.max(0, Math.ceil(card.technologies.length / 3) - 1) * 30
  const technologies = card.technologies
  for (const [index, technology] of technologies.entries()) {
    const techX = 18 + (index % 3) * 104
    const techY = 44 + Math.floor(index / 3) * 30
    drawTechnology(ctx, technology, techX, techY, 21, logos, palette.accent)
    ctx.font = `500 11px ${FONT}`; ctx.fillStyle = '#d7dfe9'; ctx.textAlign = 'left'
    ctx.fillText(fitText(ctx, technologyLabel(technology), 72), techX + 27, techY + 15)
  }
  if (!technologies.length) {
    ctx.font = `11px ${FONT}`; ctx.fillStyle = '#aab2c0'; ctx.textAlign = 'left'
    ctx.fillText('Technology not reported', 18, 59)
  }
  line(ctx, 0, 76 + techExtra, NODE_WIDTH, palette.border)
  ctx.translate(0, techExtra)
  ctx.textAlign = 'left'
  ctx.fillStyle = '#f0f2f6'
  ctx.font = `600 17px ${FONT}`
  ctx.fillText(fitText(ctx, node.label, NODE_WIDTH - 36), 18, 103)
  ctx.font = `11px ${FONT}`
  ctx.fillStyle = '#b0b9c7'
  ctx.fillText(fitText(ctx, card.subtitle, NODE_WIDTH - 36), 18, 123)

  ctx.font = `500 12px ${FONT}`
  ctx.fillStyle = palette.accent
  ctx.fillText(card.microfrontends.length ? 'Microfrontends' : card.section, 18, 154)
  ctx.textAlign = 'right'
  ctx.fillText(String(card.microfrontends.length || card.rows.length), NODE_WIDTH - 18, 154)
  line(ctx, 18, 166, NODE_WIDTH - 36, palette.border)

  if (!compact) {
    ctx.textAlign = 'left'
    if (card.microfrontends.length) {
      let groupY = 176
      const groups = [...(card.shellPages.length ? [{ name: 'Shell pages', pages: card.shellPages, framework: '' }] : []), ...card.microfrontends]
      for (const microfrontend of groups) {
        ctx.font = `600 12px ${FONT}`; ctx.fillStyle = '#e1e6ee'; ctx.textAlign = 'left'
        ctx.fillText(fitText(ctx, microfrontend.name, NODE_WIDTH - 140), 18, groupY + 17)
        if (microfrontend.framework) {
          drawTechnology(ctx, microfrontend.framework, NODE_WIDTH - 82, groupY + 2, 17, logos, palette.accent)
          ctx.font = `10px ${FONT}`; ctx.fillStyle = palette.accent
          ctx.fillText(technologyLabel(microfrontend.framework), NODE_WIDTH - 58, groupY + 15)
        }
        ctx.font = `12px ${MONO}`; ctx.fillStyle = '#b9c6d8'
        for (const [index, page] of microfrontend.pages.entries()) {
          ctx.fillText(fitText(ctx, page, NODE_WIDTH - 56), 30, groupY + 44 + index * 24)
        }
        groupY += microfrontendHeight(microfrontend)
        line(ctx, 18, groupY - 4, NODE_WIDTH - 36, palette.border)
      }
    } else for (const [index, row] of card.rows.slice(0, CARD_ROWS).entries()) {
      const rowY = 190 + index * 28
      ctx.font = `600 10px ${MONO}`
      ctx.fillStyle = row.tag === 'DELETE' || row.tag === 'DEL' ? '#ffa497' : row.tag === 'POST' || row.tag === 'INSERT' || row.tag === 'SET' ? '#c7dca3' : palette.accent
      ctx.fillText(row.tag, 18, rowY)
      ctx.font = `12px ${MONO}`
      ctx.fillStyle = '#e1e6ee'
      ctx.fillText(fitText(ctx, row.label, NODE_WIDTH - 110), 78, rowY)
    }
    if (card.rows.length === 0 && !card.microfrontends.length) {
      ctx.fillStyle = '#aab2c0'; ctx.font = `12px ${FONT}`
      ctx.fillText(card.empty, 18, 194)
    }
    ctx.fillStyle = '#aab2c0'; ctx.font = `11px ${FONT}`
    ctx.fillText(!card.microfrontends.length && card.rows.length > CARD_ROWS ? `+${card.rows.length - CARD_ROWS} more · select to view all` : 'Select to inspect', 18, card.height - techExtra - 46)
  } else {
    ctx.font = `16px ${FONT}`; ctx.fillStyle = '#c1c9d5'; ctx.textAlign = 'left'
    ctx.fillText(`${card.rows.length} ${card.kind === 'frontend' ? 'pages' : 'operations'}`, 18, 204)
  }

  ctx.translate(0, -techExtra)
  line(ctx, 0, card.height - 31, NODE_WIDTH, palette.border)
  ctx.font = `11px ${FONT}`; ctx.fillStyle = '#b0b9c7'; ctx.textAlign = 'left'
  ctx.fillText(fitText(ctx, card.footer, NODE_WIDTH - 36), 18, card.height - 12)
  // Ports make the direction of connections unambiguous.
  ctx.fillStyle = palette.surface; ctx.strokeStyle = palette.accent; ctx.lineWidth = 1.5
  for (const portX of card.kind === 'frontend' ? [NODE_WIDTH] : card.kind === 'database' || card.kind === 'cache' ? [0] : [0, NODE_WIDTH]) {
    ctx.beginPath(); ctx.arc(portX, card.height / 2, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
  }
  ctx.restore()
}

function drawTechnology(ctx: CanvasRenderingContext2D, technology: Technology, x: number, y: number, size: number,
  logos: Map<Technology, HTMLImageElement>, color: string) {
  const image = logos.get(technology)
  if (image?.complete && image.naturalWidth > 0) { ctx.drawImage(image, x, y, size, size); return }
  ctx.save(); ctx.translate(x, y); ctx.scale(size / 24, size / 24)
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  for (const path of lucideIcons['file-braces']) ctx.stroke(new Path2D(path))
  ctx.restore()
}

function line(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, color: string) {
  ctx.strokeStyle = color; ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + width, y); ctx.stroke()
}
