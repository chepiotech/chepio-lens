// Core
import { useEffect, useId, useRef, useState } from 'react'
// Components
import CanvasIcon from '../CanvasIcon'
import MapLegend from '../MapLegend/MapLegend'
// Types
import type { GraphState } from '../../map/graphState'
import type { PanelPreferences } from '../InvestigationPanel/panelPreferences'
// Styles
import './SettingsDialog.css'

export type SettingsProps = {
  graph: GraphState
  preferences: PanelPreferences
  onPreferences: (preferences: PanelPreferences) => void
  onFocusNode: (id: string) => void
  status?: 'connecting' | 'live' | 'offline'
  example?: boolean
  resetting?: boolean
  resetError?: boolean
  onReset?: () => void
}

type Props = SettingsProps & { open: boolean; onClose: () => void }
const SECTIONS = ['General', 'Console', 'Map'] as const
const STATUS_TEXT = { connecting: 'Connecting…', live: 'Live', offline: 'Collector offline' } as const

function SettingsDialog({ open, onClose, graph, preferences, onPreferences, onFocusNode,
  status = 'connecting', example = false, resetting = false, resetError = false, onReset }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const id = useId()
  const [section, setSection] = useState<typeof SECTIONS[number]>('General')
  const backdropPress = useRef(false)
  useEffect(() => {
    if (open) {
      dialog.current?.showModal()
      closeButton.current?.focus()
    }
    else dialog.current?.close()
  }, [open])

  return <dialog ref={dialog} className="settings-dialog" aria-labelledby={`${id}-title`} onClose={onClose}
    onKeyDown={(event) => {
      if (event.key !== 'Tab') return
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button, a[href], select, summary, [tabindex]')]
        .filter((element) => element.tabIndex >= 0 && !element.hasAttribute('disabled') && element.getClientRects().length > 0)
      const first = controls[0]
      const last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }}
    onPointerDown={(event) => { backdropPress.current = event.target === event.currentTarget }}
    onClick={(event) => {
      if (backdropPress.current && event.target === event.currentTarget) onClose()
      backdropPress.current = false
    }}>
    {open && <div className="settings-dialog__layout">
      <div className="settings-dialog__sidebar">
        <h2 id={`${id}-title`}>Settings</h2>
        <div className="settings-dialog__tabs" role="tablist" aria-label="Settings sections">
          {SECTIONS.map((name, index) => <button type="button" key={name} id={`${id}-tab-${name}`}
            role="tab" aria-selected={section === name} aria-controls={`${id}-panel`} tabIndex={section === name ? 0 : -1}
            onClick={() => setSection(name)} onKeyDown={(event) => {
              let next: number
              if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % SECTIONS.length
              else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index + SECTIONS.length - 1) % SECTIONS.length
              else if (event.key === 'Home') next = 0
              else if (event.key === 'End') next = SECTIONS.length - 1
              else return
              event.preventDefault()
              setSection(SECTIONS[next]!)
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
            }}>
            <CanvasIcon name={name === 'General' ? 'settings' : name === 'Console' ? 'console' : 'map'} />
            {name}
          </button>)}
        </div>
      </div>
      <button ref={closeButton} type="button" className="settings-dialog__close" aria-label="Close settings" onClick={onClose}>
        <CanvasIcon name="close" />
      </button>
      <section className="settings-dialog__content" id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${section}`}>
        <h3>{section}</h3>
        {section === 'General' && <>
          <div className="settings-dialog__row">
            <div><span>Map source</span><p>{example ? 'Illustrative data. No collector connection.' : 'Requests received by your collector.'}</p></div>
            <a className="settings-dialog__action" href={example ? '?' : '?example=architecture'}>{example ? 'Live map' : 'Example map'}</a>
          </div>
          {!example && <div className="settings-dialog__row"><span>Connection</span>
            <span className={`settings-dialog__status settings-dialog__status--${status}`} role="status">{STATUS_TEXT[status]}</span>
          </div>}
          <div className="settings-dialog__row"><span>On the canvas</span>
            <span className="settings-dialog__value">{Object.keys(graph.nodes).length} nodes · {Object.keys(graph.edges).length} connections</span>
          </div>
          {onReset && <div className="settings-dialog__row">
            <div><span>Clear session</span><p>Remove captured requests, logs and the live map.</p></div>
            <button type="button" className="settings-dialog__action settings-dialog__action--danger"
              disabled={resetting} onClick={onReset}>{resetting ? 'Resetting…' : 'Reset'}</button>
          </div>}
          {resetError && <p className="settings-dialog__error" role="alert">Reset failed. Check the collector connection and try again.</p>}
        </>}
        {section === 'Console' && <>
          <label className="settings-dialog__row"><span>Dock position</span>
            <select value={preferences.dock} onChange={(event) => onPreferences({ ...preferences,
              dock: event.target.value === 'bottom' || event.target.value === 'left' ? event.target.value : 'right' })}>
              <option value="left">Left</option><option value="right">Right</option><option value="bottom">Bottom</option>
            </select>
          </label>
          <p className="settings-dialog__hint">Resize the console by dragging its edge. Position and size are remembered on this device.</p>
          <p className="settings-dialog__hint">The console overlays the page without changing the map scale.</p>
        </>}
        {section === 'Map' && <>
          <label className="settings-dialog__row"><span>Focus a node</span>
            <select defaultValue="" onChange={(event) => { onFocusNode(event.target.value); onClose() }}>
              <option value="">Whole map</option>
              {Object.values(graph.nodes).map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}
            </select>
          </label>
          <p className="settings-dialog__hint">Drag to pan. Scroll to zoom. Double-click or press 0 to fit the map.</p>
          <MapLegend />
        </>}
      </section>
    </div>}
  </dialog>
}

export default SettingsDialog
