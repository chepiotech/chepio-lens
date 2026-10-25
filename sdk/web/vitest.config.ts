// Core
import { defineConfig } from 'vitest/config'

// OpenTelemetry JS picks its browser code (fetch transport, `webjs` resource) through the `browser` field of each
// package. Vitest loads dependencies with Node's resolver unless they are inlined, so the tests would run the Node
// build; inlining plus `mainFields` makes them run what a browser bundle gets.
export default defineConfig({
  resolve: { mainFields: ['browser', 'module', 'main'] },
  test: {
    environment: 'happy-dom',
    // The demo web's origin, so same-origin rules match what the SDK sees in the demo.
    environmentOptions: { happyDOM: { url: 'http://localhost:5173' } },
    server: { deps: { inline: [/@opentelemetry\//] } },
  },
})
