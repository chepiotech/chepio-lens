// Core
import react from '@vitejs/plugin-react'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

// Port 5173 belongs to demo/web, the default CORS origin of the collector. In development the UI API comes from a
// running collector (LENS_COLLECTOR_URL, default its UI listener); in production the collector serves this build.
export default defineConfig(({ mode }) => {
  const { LENS_COLLECTOR_URL = 'http://127.0.0.1:4320' } = loadEnv(mode, '.', 'LENS_')
  return {
    plugins: [react()],
    server: { port: 5174, strictPort: true, proxy: { '/api': LENS_COLLECTOR_URL, '/healthz': LENS_COLLECTOR_URL } },
  }
})
