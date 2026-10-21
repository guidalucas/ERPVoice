import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()],
  server: { host: '127.0.0.1', port: 5175, strictPort: true,
    proxy: Object.fromEntries(['/api', '/c/', '/catalog-assets/'].map(prefix => [prefix, { target: process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3001', changeOrigin: true }])) },
  build: { outDir: 'dist-studio', rollupOptions: { input: 'studio.html' } },
});
