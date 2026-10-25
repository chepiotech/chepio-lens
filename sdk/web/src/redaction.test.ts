// Core
import { describe, expect, it } from 'vitest'
// Domain
import { percentDecode, Redactor, type Redacted } from './redaction'
// Consts
import vectors from '../../../conventions/testdata/redaction.json' with { type: 'json' }

type Case = {
  name: string
  kind: 'header' | 'json' | 'form' | 'url'
  header?: string
  extra_keys?: string[]
  input: string
  expected: string | null
  count: number
}

describe('Redactor', () => {
  // The same vectors as `conventions` `redaction::tests::shared_vectors_pass` (I2).
  it.each((vectors.cases as Case[]).map((testCase) => [testCase.name, testCase] as const))(
    'shared vector: %s',
    (_, testCase) => {
      const redactor = new Redactor(testCase.extra_keys ?? [])
      const actual = {
        header: () => redactor.redactHeader(testCase.header ?? '', testCase.input),
        json: () => redactor.redactJson(testCase.input),
        form: () => redactor.redactForm(testCase.input),
        url: () => redactor.redactUrl(testCase.input),
      }[testCase.kind]()
      const expected: Redacted | null =
        testCase.expected === null ? null : { text: testCase.expected, count: testCase.count }
      expect(actual).toEqual(expected)
    },
  )

  it('runs every shared vector', () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(20)
  })

  it('matches keys with ASCII-only lowercasing, as the Rust version does', () => {
    const redactor = new Redactor()
    expect(redactor.isSensitiveKey('X-SESSION-ID')).toBe(true)
    // `İ` lowercases to `i̇` in Unicode but stays as it is in ASCII-only lowercasing, so this is not "secret".
    expect(redactor.isSensitiveKey('SECRİT')).toBe(false)
  })

  it('ignores blank extra keys', () => {
    const redactor = new Redactor([' ', ''])
    expect(redactor.redactHeader('x-other', 'v')).toEqual({ text: 'v', count: 0 })
  })
})

describe('percentDecode', () => {
  it('handles escapes, plus and invalid input like the Rust version', () => {
    expect(percentDecode('pass%77ord')).toBe('password')
    expect(percentDecode('a+b')).toBe('a b')
    expect(percentDecode('100%')).toBe('100%')
    expect(percentDecode('%zz')).toBe('%zz')
    expect(percentDecode('%D0%9E')).toBe('О')
  })
})
