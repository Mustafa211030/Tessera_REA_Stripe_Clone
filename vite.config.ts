import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  base: '/app-assets/',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: { '/v1': 'http://127.0.0.1:4242', '/dashboard-api': 'http://127.0.0.1:4242', '/hosted-api': 'http://127.0.0.1:4242', '/v3': 'http://127.0.0.1:4242', '/elements': 'http://127.0.0.1:4242' },
  },
});
