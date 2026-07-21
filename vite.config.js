import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    allowedHosts: true // Allows localtunnel / ngrok domains to connect
  }
});