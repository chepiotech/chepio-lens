// Core
import { describe, expect, it } from 'vitest'
// Utils
import { formatMs } from './formatMs'

describe('duration labels', () => {
  it('keeps sub-millisecond calls distinct from zero', () => {
    expect(formatMs(0.06)).toBe('0.06 ms')
    expect(formatMs(0.001)).toBe('<0.01 ms')
    expect(formatMs(0)).toBe('0.00 ms')
  })

  it('keeps longer calls compact', () => {
    expect(formatMs(2.03)).toBe('2.0 ms')
    expect(formatMs(741.4552)).toBe('741 ms')
  })
})
