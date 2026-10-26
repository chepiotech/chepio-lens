// Core
import { useRef, type CSSProperties, type ReactNode } from 'react'
// Types
import type { PanelPreferences } from './panelPreferences'
// Styles
import './InvestigationPanel.css'
// Utils
import { clampPanelSize } from './panelPreferences'

type Props = {
  preferences: PanelPreferences
  onPreferences: (preferences: PanelPreferences) => void
  onClose: () => void
  children: ReactNode
  title?: string
  label?: string
  closeLabel?: string
}

function InvestigationPanel({ preferences, onPreferences, onClose, children, title = 'Request activity',
  label = 'Logs and request inspector', closeLabel = 'Close logs panel' }: Props) {
  const drag = useRef<{ x: number; y: number; size: number } | null>(null)
  const vertical = preferences.dock !== 'bottom'
  const left = preferences.dock === 'left'
  const size = vertical ? preferences.width : preferences.height
  const resize = (value: number) => onPreferences({ ...preferences, [vertical ? 'width' : 'height']: clampPanelSize(value, preferences.dock) })
  return (
    <aside id="request-console" className={`investigation-panel investigation-panel--${preferences.dock}`} aria-label={label}
      style={{ '--panel-width': `${preferences.width}px`, '--panel-height': `${preferences.height}px` } as CSSProperties}>
      <div className="investigation-panel__resize" role="separator" tabIndex={0} aria-label="Resize logs panel"
        aria-orientation={vertical ? 'vertical' : 'horizontal'} aria-valuemin={vertical ? 340 : 220}
        aria-valuemax={vertical ? 1_000 : 800} aria-valuenow={size}
        onKeyDown={(event) => {
          const increase = vertical ? left ? 'ArrowRight' : 'ArrowLeft' : 'ArrowUp'
          const decrease = vertical ? left ? 'ArrowLeft' : 'ArrowRight' : 'ArrowDown'
          if (event.key === increase || event.key === decrease) {
            event.preventDefault(); resize(size + (event.key === increase ? 24 : -24))
          }
        }}
        onPointerDown={(event) => {
          const bounds = event.currentTarget.parentElement!.getBoundingClientRect()
          drag.current = { x: event.clientX, y: event.clientY, size: vertical ? bounds.width : bounds.height }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (drag.current) resize(drag.current.size + (vertical
            ? (event.clientX - drag.current.x) * (left ? 1 : -1)
            : drag.current.y - event.clientY))
        }}
        onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} />
      <header className="investigation-panel__header">
        <h2>{title}</h2>
        <button type="button" aria-label={closeLabel} onClick={onClose}>×</button>
      </header>
      {children}
    </aside>
  )
}

export default InvestigationPanel
