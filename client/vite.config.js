import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET || 'http://localhost:4000',
        changeOrigin: true,
        cookieDomainRewrite: '',
        configure(proxy) {
          // The dev server uses HTTP, even when the API upstream uses HTTPS.
          // Keep stream cookies usable locally; this only changes the proxied
          // response, never cookies served directly by the production site.
          proxy.on('proxyRes', (response) => {
            const cookies = response.headers['set-cookie'];
            if (cookies) response.headers['set-cookie'] = cookies.map(cookie => cookie.replace(/;\s*Secure(?=;|$)/gi, ''));
          });
        },
      },
    },
  },
});
