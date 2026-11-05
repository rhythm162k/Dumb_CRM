import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// /api is proxied so the browser sees one origin (cookies stay first-party)
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:4000' } },
});
