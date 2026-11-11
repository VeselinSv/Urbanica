import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const pkg = (name: string) => resolve(__dirname, `../../packages/${name}/src/index.ts`);

// Споделените пакети се импортират от изходния код – една и съща логика (каталог, генератор на света) на клиент и сървър.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@gce/shared': pkg('shared'),
      '@gce/world-generation': pkg('world-generation'),
      '@gce/economy-engine': pkg('economy-engine'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
});
