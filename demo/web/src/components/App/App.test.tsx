// Core
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// Components
import App from './App'

describe('App', () => {
  it('renders the demo title', () => {
    expect(renderToString(<App />)).toContain('<h1>chepio-lens demo</h1>')
  })
})
