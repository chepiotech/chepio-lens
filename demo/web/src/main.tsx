// Core
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Components
import App from './components/App/App'

// chepio-lens only in development and only with an endpoint: production builds drop this branch and the SDK with it
// (`main.test.ts`). Awaited before the first render, so the first requests are traced; a broken SDK never stops the
// page from rendering.
if (import.meta.env.DEV && import.meta.env.VITE_CHEPIO_LENS_ENDPOINT) {
  try {
    const { initLens } = await import('chepio-lens-web')
    initLens({ serviceName: 'demo-web', endpoint: import.meta.env.VITE_CHEPIO_LENS_ENDPOINT,
      node: { technologies: ['react'], pages: ['/'] },
    })
  } catch (error) {
    console.warn('chepio-lens: tracing is off', error)
  }
}

const root = document.getElementById('root')
if (!root) throw new Error('#root element is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
