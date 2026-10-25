// Core
import { describe, expect, it } from 'vitest'
// Consts
import pkg from '../package.json' with { type: 'json' }
import { SDK_VERSION } from './consts'

describe('chepio-lens-web', () => {
  it('keeps the package name from the component doc', () => {
    expect(pkg.name).toBe('chepio-lens-web')
  })

  it('reports the package version as lens.sdk.version', () => {
    expect(SDK_VERSION).toBe(pkg.version)
  })
})
