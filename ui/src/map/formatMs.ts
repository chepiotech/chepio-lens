/** Keep sub-millisecond calls readable; larger durations need fewer decimal places. */
export function formatMs(ms: number): string {
  if (ms > 0 && ms < 0.01) return '<0.01 ms'
  if (ms < 1) return `${ms.toFixed(2)} ms`
  return ms >= 100 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`
}
