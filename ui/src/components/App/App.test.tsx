// Core
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// Components
import App from './App'

describe('App', () => {
  it('renders the title and ends with the Chepio credit', () => {
    const html = renderToString(<App />)

    expect(html).toContain('chepio-lens</h1>')
    expect(html).toMatch(/<footer class="chepio-footer">.*<\/footer><\/div>$/)
    expect(html).toContain('href="https://chepio.tech"')
  })
})
