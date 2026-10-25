// TypeScript port of `conventions/src/redaction.rs` (docs/architecture/security.md). Both implementations must pass
// `conventions/testdata/redaction.json`; change them together.

/** What a masked value is replaced with. */
export const REDACTED = '[REDACTED]'

/** Header names masked by default (exact, case-insensitive). */
export const DEFAULT_HEADER_NAMES: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
]

/** JSON keys, form fields and query parameters are masked when their name contains one of these (case-insensitive). */
export const DEFAULT_KEY_PATTERNS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'session',
  'credential',
  'private_key',
  'card_number',
  'cvv',
  'iban',
]

/** Text after redaction and how many values were masked; values already equal to `REDACTED` are not counted again. */
export type Redacted = { text: string; count: number }

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export class Redactor {
  private readonly headerNames: string[]
  private readonly keyPatterns: string[]

  /** The defaults plus `extraKeys`, which apply both as header names and as key patterns. */
  constructor(extraKeys: readonly string[] = []) {
    const extra = extraKeys.map((key) => asciiLowercase(key.trim())).filter((key) => key !== '')
    this.headerNames = [...DEFAULT_HEADER_NAMES, ...extra]
    this.keyPatterns = [...DEFAULT_KEY_PATTERNS, ...extra]
  }

  isSensitiveHeader(name: string): boolean {
    return this.headerNames.includes(asciiLowercase(name))
  }

  isSensitiveKey(key: string): boolean {
    const lower = asciiLowercase(key)
    return this.keyPatterns.some((pattern) => lower.includes(pattern))
  }

  /** Masks a header value when the header name is sensitive. */
  redactHeader(name: string, value: string): Redacted {
    return this.isSensitiveHeader(name) && value !== REDACTED ? { text: REDACTED, count: 1 } : unchanged(value)
  }

  /**
   * Masks the values of sensitive keys at any depth. `null` when `body` is not valid JSON: such a body is kept as
   * text without key-based masking. Unlike the Rust version, re-serializing moves integer-like keys first and rounds
   * integers beyond 2^53; that only happens when something was masked.
   */
  redactJson(body: string): Redacted | null {
    let value: Json
    try {
      value = JSON.parse(body) as Json
    } catch {
      return null
    }
    const masked = this.maskJson(value)
    return { text: masked.count === 0 ? body : JSON.stringify(masked.value), count: masked.count }
  }

  private maskJson(value: Json): { value: Json; count: number } {
    if (Array.isArray(value)) {
      const items = value.map((item) => this.maskJson(item))
      return { value: items.map((item) => item.value), count: sum(items.map((item) => item.count)) }
    }
    if (value === null || typeof value !== 'object') return { value, count: 0 }
    let count = 0
    const object: { [key: string]: Json } = {}
    for (const [key, item] of Object.entries(value)) {
      if (!this.isSensitiveKey(key)) {
        const masked = this.maskJson(item)
        object[key] = masked.value
        count += masked.count
      } else {
        object[key] = REDACTED
        if (item !== REDACTED) count += 1
      }
    }
    return { value: object, count }
  }

  /**
   * Masks sensitive fields of an `application/x-www-form-urlencoded` body or a URL query string, keeping order and
   * separators. Field names are percent-decoded before matching.
   */
  redactForm(form: string): Redacted {
    let count = 0
    const text = form
      .split('&')
      .map((pair) => {
        const [key, value] = splitOnce(pair, '=') ?? []
        if (key === undefined || value === REDACTED || !this.isSensitiveKey(percentDecode(key))) return pair
        count += 1
        return `${key}=${REDACTED}`
      })
      .join('&')
    return { text, count }
  }

  /** Masks sensitive query parameters of a URL; the path and the fragment are kept. */
  redactUrl(url: string): Redacted {
    const [base, rest] = splitOnce(url, '?') ?? []
    if (base === undefined || rest === undefined) return unchanged(url)
    const [query, fragment] = splitOnce(rest, '#') ?? [rest, undefined]
    const redacted = this.redactForm(query)
    const text = fragment === undefined ? `${base}?${redacted.text}` : `${base}?${redacted.text}#${fragment}`
    return { text, count: redacted.count }
  }
}

function unchanged(text: string): Redacted {
  return { text, count: 0 }
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function splitOnce(text: string, separator: string): [string, string] | null {
  const index = text.indexOf(separator)
  return index < 0 ? null : [text.slice(0, index), text.slice(index + separator.length)]
}

/** Lowercases A–Z only, as Rust's `to_ascii_lowercase`, so both sides match the same keys. */
function asciiLowercase(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}

const PLUS = 0x2b
const PERCENT = 0x25
const SPACE = 0x20

/** Decodes `%XX` escapes and `+` (space); invalid escapes stay as they are, unlike `decodeURIComponent`. */
export function percentDecode(input: string): string {
  const bytes = new TextEncoder().encode(input)
  const decoded: number[] = []
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0
    const high = hexDigit(bytes[i + 1])
    const low = hexDigit(bytes[i + 2])
    if (byte === PLUS) {
      decoded.push(SPACE)
    } else if (byte === PERCENT && high !== null && low !== null) {
      decoded.push((high << 4) | low)
      i += 2
    } else {
      decoded.push(byte)
    }
  }
  return new TextDecoder().decode(new Uint8Array(decoded))
}

function hexDigit(byte: number | undefined): number | null {
  if (byte === undefined) return null
  const digit = Number.parseInt(String.fromCharCode(byte), 16)
  return Number.isNaN(digit) ? null : digit
}
