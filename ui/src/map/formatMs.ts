/** Milliseconds for labels: one decimal below 100 ms, whole numbers above. */
export function formatMs(ms: number): string {
  return ms >= 100 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`
}
