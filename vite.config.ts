import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: { stocky: 'index.html', studio: 'studio.html' },
    },
  },
  server: {
    allowedHosts: ['bc8b-186-124-193-161.ngrok-free.app'],
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
});
