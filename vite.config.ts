import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    __COLLKIP_WINDOWS_DESKTOP__: JSON.stringify(process.env.VITE_WINDOWS_DESKTOP === 'true'),
  },
  // Use an absolute root base for AppDeploy's managed frontend asset routing.
  // Relative base paths can resolve under /api/ and cause the hosted app to request
  // frontend assets from /api/assets instead of the managed frontend asset location.
  base: '/',
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: process.env.APPDEPLOY_VITE_OUT_DIR || 'dist',
    sourcemap:
      process.env.APPDEPLOY_VITE_SOURCEMAP === 'hidden' ? 'hidden' : false,
    rollupOptions: {
      maxParallelFileOps: 128,
    },
  },
});
