// Core
import { describe, expect, it } from 'vitest'
// Utils
import { normalizeNodeMetadata } from './nodeMetadata'
// Consts
import vectors from '../../../../conventions/testdata/node_metadata.json' with { type: 'json' }

describe('node metadata', () => {
  it('passes the shared Rust and web vectors', () => {
    for (const vector of vectors) expect(normalizeNodeMetadata(vector.input), vector.name).toEqual(vector.expected)
  })

  it('bounds the entire page inventory and ignores malformed settings', () => {
    expect(normalizeNodeMetadata(null)).toBeUndefined()
    expect(normalizeNodeMetadata([])).toBeUndefined()
    const value = normalizeNodeMetadata({ technologies: Array.from({ length: 100 }, (_, i) => `tech-${i}`),
      pages: Array.from({ length: 100 }, (_, i) => `/page-${i}?fake=secret`),
      microfrontends: [{ name: 'x'.repeat(100), framework: 'react', pages: ['/other'] }] })!
    expect(value.technologies).toHaveLength(16)
    expect(value.pages).toHaveLength(32)
    expect(value.microfrontends[0]!.pages).toEqual([])
    expect(value.microfrontends[0]!.name).toHaveLength(64)
    expect(JSON.stringify(value)).not.toContain('secret')
  })
})
