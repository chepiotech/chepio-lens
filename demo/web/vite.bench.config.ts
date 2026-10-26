// Core
import { defineConfig } from 'vite'
// Services
import { benchApi } from './src/sdkOverhead/benchApi'

// Web SDK overhead bench (`pnpm --filter demo-e2e sdk-overhead`): serves `sdk-overhead.html` and the bench API on a
// port of its own, so it runs beside the demo stack; the bench's collector allows this origin. Cross-origin
// isolation gives `performance.now()` 5 µs resolution instead of 100 µs; the SDK's exports are CORS requests, which
// COEP allows.
export default defineConfig({
  plugins: [benchApi()],
  server: {
    host: '127.0.0.1',
    port: 5186,
    strictPort: true,
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
  // Optimized up front: discovering the SDK's dependencies on the first load would reload the page mid-slot.
  optimizeDeps: { entries: ['sdk-overhead.html'] },
})
