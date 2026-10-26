// Core
import { useState } from 'react'
// Components
import CanvasIcon from '../CanvasIcon'
import SettingsDialog, { type SettingsProps } from '../SettingsDialog/SettingsDialog'
// Styles
import './CanvasControls.css'

type Props = SettingsProps & { consoleOpen: boolean; onToggleConsole: () => void }

function CanvasControls({ consoleOpen, onToggleConsole, ...settings }: Props) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  return <>
    <button type="button" className="canvas-controls__button canvas-controls__button--console"
      aria-label="Console" title="Console" aria-expanded={consoleOpen}
      aria-controls="request-console" onClick={onToggleConsole}>
      <CanvasIcon name="console" />
    </button>
    <button type="button" className="canvas-controls__button canvas-controls__button--settings"
      aria-label="Settings" title="Settings" aria-haspopup="dialog" onClick={() => setSettingsOpen(true)}>
      <CanvasIcon name="settings" />
    </button>
    <SettingsDialog {...settings} open={settingsOpen} onClose={() => setSettingsOpen(false)} />
  </>
}

export default CanvasControls
