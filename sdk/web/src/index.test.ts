// Core
import { describe, expect, it } from 'vitest'
// Consts
import pkg from '../package.json' with { type: 'json' }

describe('chepio-lens-web', () => {
  it('keeps the package name from the component doc', () => {
    expect(pkg.name).toBe('chepio-lens-web')
  })
})
