import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/client',
  base: './',
  build: {
    outDir: '../../dist/public',
    emptyOutDir: true,
    target: 'es2020',
  },
  server: {
    port: 5173,
    proxy: {
      // game websocket is served by the node server in dev
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
