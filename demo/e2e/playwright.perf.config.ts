// Core
import { defineConfig, devices } from '@playwright/test'

// Map frame-time measurement (not part of CI): starts the UI dev server for `perf.html` and measures at device
// pixel ratio 1 and 2. Record results in docs/architecture/quality-attributes.md.
export default defineConfig({
  testDir: 'perf',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  webServer: {
    command: 'pnpm --filter ui dev',
    url: 'http://localhost:5174/perf.html',
    reuseExistingServer: true,
  },
  projects: [
    { name: 'dpr1', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } },
    { name: 'dpr2', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 } },
  ],
})
