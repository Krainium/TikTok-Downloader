import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

// React + TS frontend. Built into frontend/dist and served by frontend/server.ts
// on port 4444. In dev (`npm run web:dev`) Vite serves with HMR on 5173 and
// proxies /api to the Node server (run `npm run web:serve` alongside).
export default defineConfig({
  root: dir,
  base: '/',
  plugins: [react()],
  build: {
    outDir: path.join(dir, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4444', changeOrigin: true },
    },
  },
});
