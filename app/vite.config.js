import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Los datos de clientes en S3 (Bodesa) los sirve backend/server.js
    proxy: { '/api': 'http://127.0.0.1:8011' },
  },
  preview: {
    proxy: { '/api': 'http://127.0.0.1:8011' },
  },
})
