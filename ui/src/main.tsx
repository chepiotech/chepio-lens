// Core
import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
// Components
import App from './components/App/App'
import ExampleMap from './components/ExampleMap/ExampleMap'
// Styles
import './index.css'

const TaskHubDemo = lazy(() => import('./components/TaskHubDemo/TaskHubDemo'))

const root = document.getElementById('root')
if (!root) throw new Error('#root element is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <Suspense fallback={<p role="status">Loading map…</p>}>
      {new URLSearchParams(window.location.search).get('example') === 'taskhub' ? <TaskHubDemo />
        : new URLSearchParams(window.location.search).get('example') === 'architecture' ? <ExampleMap /> : <App />}
    </Suspense>
  </StrictMode>,
)
