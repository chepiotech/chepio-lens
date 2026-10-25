// @vitest-environment node
// Core
import { fileURLToPath } from 'node:url'
import { build, type Rolldown } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// Strings that only the web SDK and OpenTelemetry put into a bundle.
const SDK_MARKERS = ['lens.sdk.version', 'chepio-lens: endpoint', 'opentelemetry']

/**
 * Builds the demo web in memory and returns the text of every output file. Vitest sets `NODE_ENV=test`, which would
 * keep `import.meta.env.DEV` true; a real `vite build` runs with `production`.
 */
async function bundle(define: Record<string, string> = {}): Promise<string[]> {
  vi.stubEnv('NODE_ENV', 'production')
  const result = await build({ root: ROOT, logLevel: 'silent', define, build: { write: false } })
  const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[]
  return outputs.flatMap((output) =>
    output.output.map((file) => (file.type === 'chunk' ? file.code : String(file.source))),
  )
}

function sdkMarkers(files: string[]): string[] {
  return SDK_MARKERS.filter((marker) => files.some((file) => file.includes(marker)))
}

afterEach(() => {
  vi.unstubAllEnvs()
})

// security.md: the web SDK is added through a dev-only dynamic import, so production builds do not contain it.
describe('demo web bundle', () => {
  it('leaves the chepio-lens SDK out of production builds, even with an endpoint set', async () => {
    vi.stubEnv('VITE_CHEPIO_LENS_ENDPOINT', 'http://localhost:4318')

    expect(sdkMarkers(await bundle())).toEqual([])
  }, 60_000)

  // Control: the same build with the development flag forced on does contain the SDK, so the check above can fail.
  it('contains the SDK when the development branch is kept', async () => {
    vi.stubEnv('VITE_CHEPIO_LENS_ENDPOINT', 'http://localhost:4318')

    expect(sdkMarkers(await bundle({ 'import.meta.env.DEV': 'true' }))).toEqual(SDK_MARKERS)
  }, 60_000)
})
