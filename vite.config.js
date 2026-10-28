import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

/* The version the app shows (sidebar foot, login page). Every production
 * deploy is 0.1 higher than the last, starting at 1.0: the pipeline works it
 * out from the newest v* tag and passes it in as APP_VERSION, and the deploy
 * tags the commit with it (DevOps.md §11). A local build shows the newest tag
 * with "-dev"; package.json's version is not used. The commit is read at build
 * time for support ("which build is that?"). */
let APP_VERSION = process.env.APP_VERSION || ''
if (!APP_VERSION) try { APP_VERSION = `${execSync('git describe --tags --abbrev=0 --match "v[0-9]*"', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().slice(1)}-dev` } catch { APP_VERSION = 'dev' }
// A Docker build has no .git: it passes the commit in as APP_COMMIT.
let APP_COMMIT = process.env.APP_COMMIT || ''
if (!APP_COMMIT) try { APP_COMMIT = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { /* not a checkout */ }

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
    include: ['src/**/*.test.{js,jsx}'],
  },

  // The stylesheets are SCSS (sass), compiled with Sass's current API.
  css: { preprocessorOptions: { scss: { api: 'modern-compiler' } } },

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
