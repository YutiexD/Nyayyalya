/**
 * Vite config for the LEXX React client.
 *
 * Single-page app now, where the previous client was multi-page. The dev server
 * proxies to the API rather than relying on CORS, so the browser sees one origin and
 * the cookie/token handling in development matches production.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:5000';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(here, 'src') },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      // The public certificate verifier is mounted OUTSIDE /api on the server, so it
      // needs its own entry — see backend/routes/certificate.js.
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
      output: {
        // Split the heavy, rarely-changing libraries out of the app chunk so a code
        // change does not invalidate them in the browser cache.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          state: ['@reduxjs/toolkit', 'react-redux', '@tanstack/react-query'],
          motion: ['gsap'],
        },
      },
    },
  },
});
