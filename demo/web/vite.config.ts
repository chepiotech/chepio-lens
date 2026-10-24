// Core
import react from '@vitejs/plugin-react'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

// Port 5173 is the collector's default CORS origin (CHEPIO_LENS_CORS_ORIGINS). The browser calls `/api` on the same
// origin; the dev server proxies it to the demo API (DEMO_API_URL; compose sets http://api:8080).
export default defineConfig(({ mode }) => {
  const { DEMO_API_URL = 'http://127.0.0.1:8080' } = loadEnv(mode, '.', 'DEMO_')
  return {
    plugins: [react()],
    server: { port: 5173, strictPort: true, proxy: { '/api': DEMO_API_URL } },
    test: { environment: 'happy-dom', setupFiles: ['./src/setupTests.ts'] },
  }
})
