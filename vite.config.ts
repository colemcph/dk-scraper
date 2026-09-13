import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The React app lives in src/web and is built to dist/web, which the Node server serves in production.
// In development, Vite serves the UI and proxies API + SSE calls to the server on :3000.
export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: false },
      '/healthz': { target: 'http://localhost:3000' },
    },
  },
});
