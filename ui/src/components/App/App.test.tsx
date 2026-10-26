// Core
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// Components
import App from './App'

describe('App', () => {
  it('renders only the map, icon controls and the Chepio footer before opening a panel', () => {
    const html = renderToString(<App />)

    expect(html).not.toContain('<header')
    expect(html).not.toContain('<h1')
    expect(html).not.toContain('Connecting…')
    expect(html).toContain('aria-label="Console"')
    expect(html).toContain('aria-label="Settings"')
    expect(html).not.toContain('>Fit map<')
    expect(html).toContain('<canvas')
    expect(html).toMatch(/<footer class="chepio-footer">.*<\/footer><\/div>$/)
    expect(html).toContain('href="https://chepio.tech"')
  })
})
