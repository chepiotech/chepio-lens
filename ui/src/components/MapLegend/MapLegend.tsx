// Core
import { useState } from 'react'
// Types
import type { Glyph } from '../../map/packets'
// Styles
import './MapLegend.css'
// Utils
import { type LucideIcon, lucideIcons } from '../../map/icons/lucideIcons'
import { LEGEND, PACKET_COLORS } from '../../map/packets'
import { readLegendOpen, saveLegendOpen } from './legendPreference'

/** The same Lucide path data the canvas draws, as React elements (no `innerHTML`, I11). */
function Icon({ icon, color, className }: { icon: LucideIcon; color: string; className: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true">
      {lucideIcons[icon].map((data, index) => <path key={index} d={data} />)}
    </svg>
  )
}

function Sample({ glyph }: { glyph: Glyph }) {
  return (
    <span className="map-legend__sample" style={{ borderColor: glyph.color }}>
      <Icon icon={glyph.icon} color={glyph.color} className="map-legend__icon" />
      {glyph.badge && <Icon icon={glyph.badge} color={PACKET_COLORS.badge} className="map-legend__badge" />}
    </span>
  )
}

/** What the packet icons and node flashes on the map mean; a small closed chip until opened, then remembered. */
function MapLegend() {
  const [open, setOpen] = useState(readLegendOpen)
  return (
    <details className="map-legend" open={open}
      onToggle={(event) => { const next = event.currentTarget.open; setOpen(next); saveLegendOpen(next) }}>
      <summary className="map-legend__summary">Legend</summary>
      <ul className="map-legend__list">
        {LEGEND.map(({ glyph, text }) => (
          <li key={text} className="map-legend__item">
            <Sample glyph={glyph} />
            <span className="map-legend__label" style={{ color: glyph.color }}>{glyph.label}</span>
            <span>{text}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}

export default MapLegend
