// Core
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Components
import App from './components/App/App'

const root = document.getElementById('root')
if (!root) throw new Error('#root element is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
