/**
 * Vite multi-page build.
 *
 * Seven role views plus a public verifier, each an ordinary HTML page with its own
 * entry module. No framework: the spec locked the stack, and the pages are dense
 * forms and tables rather than an application shell, so a router and a virtual DOM
 * would buy nothing and cost bundle size on a projector at the back of a room.
 *
 * The dev server proxies to the API rather than relying on CORS, so the browser sees
 * one origin in development and in the built deployment alike.
 */
import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const page = (name) => resolve(here, `${name}.html`);

const API_TARGET = process.env.LEXX_API_ORIGIN || 'http://localhost:5000';

export default defineConfig({
  root: here,
  // No static asset directory: every asset this client uses is bundled, so nothing
  // is served unhashed and nothing can shadow the /public API proxy below.
  publicDir: false,
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      // The public certificate verifier. Mounted OUTSIDE /api on the server, so it
      // needs its own proxy entry — see backend/routes/certificate.js.
      '/public': { target: API_TARGET, changeOrigin: true },
      '/healthz': { target: API_TARGET, changeOrigin: true },
      '/readyz': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        index: page('index'),
        login: page('login'),
        officer: page('officer'),
        sho: page('sho'),
        fsl: page('fsl'),
        court: page('court'),
        lawyer: page('lawyer'),
        verify: page('verify'),
      },
    },
  },
});
