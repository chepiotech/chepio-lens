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
}

function InvestigationPanel({ preferences, onPreferences, onClose, children }: Props) {
  const drag = useRef<{ x: number; y: number; size: number } | null>(null)
  const vertical = preferences.dock === 'right'
  const size = vertical ? preferences.width : preferences.height
  const resize = (value: number) => onPreferences({ ...preferences, [vertical ? 'width' : 'height']: clampPanelSize(value, preferences.dock) })
  return (
    <aside className={`investigation-panel investigation-panel--${preferences.dock}`} aria-label="Logs and request inspector"
      style={{ '--panel-width': `${preferences.width}px`, '--panel-height': `${preferences.height}px` } as CSSProperties}>
      <div className="investigation-panel__resize" role="separator" tabIndex={0} aria-label="Resize logs panel"
        aria-orientation={vertical ? 'vertical' : 'horizontal'} aria-valuemin={vertical ? 340 : 220}
        aria-valuemax={vertical ? 1_000 : 800} aria-valuenow={size}
        onKeyDown={(event) => {
          const increase = vertical ? 'ArrowLeft' : 'ArrowUp'
          const decrease = vertical ? 'ArrowRight' : 'ArrowDown'
          if (event.key === increase || event.key === decrease) {
            event.preventDefault(); resize(size + (event.key === increase ? 24 : -24))
          }
        }}
        onPointerDown={(event) => { drag.current = { x: event.clientX, y: event.clientY, size }; event.currentTarget.setPointerCapture(event.pointerId) }}
        onPointerMove={(event) => {
          if (drag.current) resize(drag.current.size + (vertical ? drag.current.x - event.clientX : drag.current.y - event.clientY))
        }}
        onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} />
      <header className="investigation-panel__header">
        <h2>Request activity</h2>
        <div className="investigation-panel__actions">
          <button type="button" className="investigation-panel__dock" onClick={() => onPreferences({ ...preferences, dock: vertical ? 'bottom' : 'right' })}>
            {vertical ? 'Dock at bottom' : 'Dock on right'}
          </button>
          <button type="button" aria-label="Close logs panel" onClick={onClose}>×</button>
        </div>
      </header>
      {children}
    </aside>
  )
}

export default InvestigationPanel
