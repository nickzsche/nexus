/// <reference types="vitest" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  base: './',                       // Electron'da file:// altında da çalışsın
  server: { port: 5173, host: '127.0.0.1' },
  build: { target: 'es2022', sourcemap: true },
  test: { environment: 'jsdom', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'], globals: false },
});
