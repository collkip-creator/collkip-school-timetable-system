import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: resolve(projectRoot, 'mobile'),
  plugins: [react()],
  base: './',
  build: {
    outDir: resolve(projectRoot, 'dist-mobile'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      maxParallelFileOps: 128,
    },
  },
});
