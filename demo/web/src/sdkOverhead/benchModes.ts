// Core
import type { LensOptions } from 'chepio-lens-web'

/**
 * `off`: the page never loads the SDK, as an app built without it (a missing endpoint returns before anything is
 * installed, so it needs no mode of its own). `spans`: export without bodies. `bodies`: export with bodies at the
 * default 16 KiB limit. `unreachable`: bodies on, nothing listens at the endpoint.
 */
export const MODES = ['off', 'spans', 'bodies', 'unreachable'] as const
export type Mode = (typeof MODES)[number]

export const SERVICE_NAME = 'sdk-overhead-web'

export function isMode(value: unknown): value is Mode {
  return MODES.some((mode) => mode === value)
}

/** What the page passes to `initLens` in `mode`; `null` when it does not load the SDK. */
export function lensOptions(mode: Mode, endpoint: string): LensOptions | null {
  if (mode === 'off') return null
  return { serviceName: SERVICE_NAME, endpoint, captureBodies: mode !== 'spans' }
}
