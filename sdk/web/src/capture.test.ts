// Core
import { describe, expect, it } from 'vitest'
// Domain
import { REDACT_BUFFER, bodyAttributes, cutUtf8, headerAttributes, readLimited, textKind } from './capture'
import { Redactor } from './redaction'

const config = (bodyLimit = 16_384, bodies = true) => ({ bodies, bodyLimit, redactor: new Redactor() })
const bytes = (text: string) => new TextEncoder().encode(text)

function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks.shift()
      if (chunk) controller.enqueue(chunk)
      else controller.close()
    },
  })
}

describe('capture', () => {
  it('decides by content type how a body is masked', () => {
    expect(textKind('application/json; charset=utf-8')).toBe('json')
    expect(textKind('application/problem+json')).toBe('json')
    expect(textKind('application/x-www-form-urlencoded')).toBe('form')
    expect(textKind('text/html')).toBe('plain')
    expect(textKind('image/png')).toBeNull()
    expect(textKind(null)).toBeNull()
  })

  // Same case as the Rust SDK's `json_is_masked_whole_before_it_is_cut`.
  it('masks JSON whole before cutting it', () => {
    const body = '{"password":"demo-password","text":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'

    const captured = bodyAttributes('request', 'json', { bytes: bytes(body), complete: true }, config(30))

    expect(captured).toEqual({
      attributes: {
        'http.request.body.size': body.length,
        'lens.http.request.body': '{"password":"[REDACTED]","text',
        'lens.http.request.body.truncated': true,
      },
      count: 1,
    })
  })

  it('keeps no text for bodies too large to mask, and only the size for other types or with capture off', () => {
    expect(bodyAttributes('response', 'plain', { bytes: new Uint8Array(), complete: false }, config())).toEqual({
      attributes: { 'lens.http.response.body.truncated': true },
      count: 0,
    })
    expect(bodyAttributes('response', null, { bytes: bytes('PNG'), complete: true }, config()).attributes).toEqual({
      'http.response.body.size': 3,
    })
    expect(bodyAttributes('request', 'json', { bytes: bytes('{"a":1}'), complete: true }, config(16, false))).toEqual(
      { attributes: { 'http.request.body.size': 7 }, count: 0 },
    )
  })

  it('cuts at UTF-8 character boundaries', () => {
    expect(cutUtf8('абв', 3)).toEqual({ text: 'а', truncated: true })
    expect(cutUtf8('abc', 3)).toEqual({ text: 'abc', truncated: false })
  })

  it('masks sensitive headers', () => {
    const headers = new Headers({ Authorization: 'Bearer t', Accept: 'application/json' })

    expect(headerAttributes('request', headers, new Redactor())).toEqual({
      attributes: {
        'http.request.header.accept': ['application/json'],
        'http.request.header.authorization': ['[REDACTED]'],
      },
      count: 1,
    })
  })

  it('reads a stream to its end, or gives up past the redaction buffer', async () => {
    expect(await readLimited(stream([bytes('one '), bytes('two')]))).toEqual({ bytes: bytes('one two'), complete: true })

    const huge = await readLimited(stream([new Uint8Array(REDACT_BUFFER), new Uint8Array(1)]))
    expect(huge.complete).toBe(false)
  })
})
