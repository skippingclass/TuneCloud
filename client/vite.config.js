import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { pwaBuild } from './scripts/pwa-build.js';

const proxyTarget = process.env.API_PROXY_TARGET || 'http://localhost:4000';

export default defineConfig({
  plugins: [react(), pwaBuild()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: proxyTarget,
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
      '/rest': {
        target: proxyTarget,
        changeOrigin: true,
      },
    },
  },
});
