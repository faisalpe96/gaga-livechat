import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3002,
    host: '127.0.0.1',
    proxy: {
      '/v1': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
