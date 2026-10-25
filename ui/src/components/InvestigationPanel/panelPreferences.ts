export type Dock = 'right' | 'bottom'
export type PanelPreferences = { dock: Dock; width: number; height: number }
export const PANEL_DEFAULTS: PanelPreferences = { dock: 'right', width: 520, height: 360 }
const KEY = 'chepio-lens.panel'

export function clampPanelSize(size: number, dock: Dock): number {
  return Math.min(dock === 'right' ? 1_000 : 800, Math.max(dock === 'right' ? 340 : 220, size))
}

export function readPanelPreferences(): PanelPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<PanelPreferences> | null
    return {
      dock: value?.dock === 'bottom' ? 'bottom' : 'right',
      width: typeof value?.width === 'number' && Number.isFinite(value.width) ? clampPanelSize(value.width, 'right') : PANEL_DEFAULTS.width,
      height: typeof value?.height === 'number' && Number.isFinite(value.height) ? clampPanelSize(value.height, 'bottom') : PANEL_DEFAULTS.height,
    }
  } catch { return PANEL_DEFAULTS }
}

export function savePanelPreferences(value: PanelPreferences) {
  try { localStorage.setItem(KEY, JSON.stringify(value)) } catch { /* Storage may be disabled; the panel still works. */ }
}
