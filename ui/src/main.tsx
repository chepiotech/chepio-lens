// Core
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Components
import App from './components/App/App'
import ExampleMap from './components/ExampleMap/ExampleMap'
// Styles
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root element is missing from index.html')

createRoot(root).render(
  <StrictMode>
    {new URLSearchParams(window.location.search).get('example') === 'architecture' ? <ExampleMap /> : <App />}
  </StrictMode>,
)
