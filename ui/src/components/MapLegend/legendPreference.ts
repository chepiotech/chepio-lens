const STORAGE_KEY = 'chepio-lens.legend.open'

/** Whether the legend is open: closed, so it never covers the map, until the user opens it; then remembered. */
export function readLegendOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function saveLegendOpen(open: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, String(open))
  } catch {
    // Not remembered; the legend still works.
  }
}
