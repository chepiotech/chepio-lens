// Core
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Port 5173 belongs to demo/web, the default CORS origin of the collector.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true },
})
