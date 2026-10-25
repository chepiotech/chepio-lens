// Core
import { defineConfig, devices } from '@playwright/test'

// Runs against a demo stack that is already up (`docker compose -f demo/compose.yaml up`); see demo/README.md.
export default defineConfig({
  testDir: 'tests',
  timeout: 60_000,
  retries: 0,
  // Every integration test uses the same collector and resets its in-memory session.
  workers: 1,
  reporter: 'list',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
