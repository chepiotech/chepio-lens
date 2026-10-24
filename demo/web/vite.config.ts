// Core
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Port 5173 is the collector's default CORS origin (CHEPIO_LENS_CORS_ORIGINS).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
})
