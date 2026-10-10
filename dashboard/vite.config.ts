import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In dev, API calls go to the gateway on :8080.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/v1': 'http://127.0.0.1:8080', '/admin': 'http://127.0.0.1:8080' } },
});
