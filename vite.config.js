import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

/* The version the app shows (sidebar foot, login page) — package.json's, so
 * `npm version patch|minor|major` is the one place it changes. The commit is
 * read at build time for support ("which build is that?"); no git, no hash. */
const APP_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
let APP_COMMIT = ''
try { APP_COMMIT = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { /* not a checkout */ }

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __APP_COMMIT__: JSON.stringify(APP_COMMIT),
    __APP_BUILT__: JSON.stringify(new Date().toISOString()),
  },

  /**
   * Unit tests.
   *
   * `node`, not jsdom: what is worth pinning here is the DECISION logic — which
   * fault a row represents and what somebody should do about it — and none of
   * that touches the DOM. A browser environment would be a dependency and a
   * startup cost bought for nothing. Add jsdom the day a component test earns
   * it, not before.
   *
   * Vitest reuses this config, so the `@` alias and `import.meta.env` behave in
   * a test exactly as they do in the app — which is the point of running it
   * here rather than under a second toolchain.
   */
  test: {
    environment: 'node',
    /* tools/ as well as src/. The KML converter that builds the Kabras site
     * layer is build-time code, but it carries the kind of rule this project
     * tests everywhere else — and it shipped a regex that compiled to
     * something matching nothing while reporting success. A tool that writes
     * a file the map draws is not exempt from having its decisions pinned. */
    include: ['src/**/*.test.{js,jsx}', 'tools/**/*.test.{js,mjs}'],
  },

  plugins: [react()],
  server: {
    // The Go API (server/) listens on 8080 by default.
    port: 5174,
    strictPort: true,
    open: true,
    // Same-origin API in dev: relative /api/* calls (services/api.js) are proxied
    // to the backend, so no CORS and no hardcoded host baked into the build.
    // The live stream is proxied too, so its cookie sign-in works unchanged.
    proxy: {
      '/api': {
        // samad's own server (server/, Go): run it with `go run .` in server/.
        // Override without editing this file: VITE_PROXY_TARGET=http://<host> npm run dev
        target: process.env.VITE_PROXY_TARGET || 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'build', // matches the old CRA output folder name, optional
  },
})
