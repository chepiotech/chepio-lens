// Core
import { useEffect, useRef, useState } from 'react'
// Components
import CanvasControls from '../CanvasControls/CanvasControls'
import ChepioTechFooter from '../ChepioTechFooter/ChepioTechFooter'
import DetailsPanel from '../DetailsPanel/DetailsPanel'
import InvestigationPanel from '../InvestigationPanel/InvestigationPanel'
import MapSummary from '../MapSummary/MapSummary'
import MapView, { type MapHandle } from '../MapView/MapView'
// Types
import type { Selection } from '../../map/MapRenderer'
// Styles
import '../App/App.css'
import './ExampleMap.css'
// Utils
import { exampleCatalog, exampleGraph } from '../../map/exampleGraph'
import { readPanelPreferences, savePanelPreferences } from '../InvestigationPanel/panelPreferences'

function ExampleMap() {
  const mapRef = useRef<MapHandle>(null)
  const [selection, setSelection] = useState<Selection>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [preferences, setPreferences] = useState(readPanelPreferences)
  useEffect(() => savePanelPreferences(preferences), [preferences])
  return <div className="app">
    <main className="app__main">
      <div className="app__map">
        <MapView ref={mapRef} graph={exampleGraph} catalog={exampleCatalog} selection={selection} onSelect={setSelection} />
        <MapSummary graph={exampleGraph} catalog={exampleCatalog} />
        <CanvasControls graph={exampleGraph} example consoleOpen={panelOpen} onToggleConsole={() => setPanelOpen((value) => !value)}
          preferences={preferences} onPreferences={setPreferences}
          onFocusNode={(id) => { setSelection(null); mapRef.current?.focusNode(id) }} />
        {selection && <DetailsPanel graph={exampleGraph} catalog={exampleCatalog} selection={selection} onClose={() => setSelection(null)} />}
      </div>
      {panelOpen && <InvestigationPanel preferences={preferences} onPreferences={setPreferences} onClose={() => setPanelOpen(false)}>
        <div className="example-map__console">
          <p>No live requests in this example.</p>
          <p>Open the live map to inspect requests from your collector.</p>
          <a href="?">Open live map</a>
        </div>
      </InvestigationPanel>}
    </main>
    <ChepioTechFooter />
  </div>
}

export default ExampleMap
