// Core
import { defineConfig, devices } from '@playwright/test'

// Isolated built UI; no collector, reset or Docker stack required.
export default defineConfig({
  testDir: 'map-cards',
  timeout: 30_000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5194' },
  webServer: {
    command: 'pnpm --filter ui exec vite preview --host 127.0.0.1 --port 5194 --strictPort',
    url: 'http://127.0.0.1:5194',
    reuseExistingServer: false,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } },
  ],
})
