import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3005,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3004',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
