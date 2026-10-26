// Core
import { defineConfig, devices } from '@playwright/test'

// Web SDK overhead measurement (not part of CI): starts the bench page's dev server and a release collector of its
// own, on ports beside the demo stack's, so both can run at once. Record results in
// docs/architecture/quality-attributes.md.
export default defineConfig({
  testDir: 'sdk-overhead',
  workers: 1,
  reporter: 'list',
  webServer: [
    {
      command: 'pnpm --filter demo-web exec vite --config vite.bench.config.ts',
      url: 'http://127.0.0.1:5186/sdk-overhead.html',
      reuseExistingServer: true,
    },
    {
      // The first run builds the collector.
      command: 'cargo run --release -p chepio-lens-collector',
      cwd: '../..',
      url: 'http://127.0.0.1:34320/healthz',
      timeout: 900_000,
      reuseExistingServer: true,
      env: {
        CHEPIO_LENS_OTLP_ADDR: '127.0.0.1:34318',
        CHEPIO_LENS_UI_ADDR: '127.0.0.1:34320',
        CHEPIO_LENS_CORS_ORIGINS: 'http://127.0.0.1:5186',
      },
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
