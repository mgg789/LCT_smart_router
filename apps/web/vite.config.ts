/// <reference types="vitest/config" />

import { execFileSync } from 'node:child_process';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { offlineBundle } from './scripts/offline-plugin.ts';

function buildRevision(): string {
  if (process.env.VITE_APP_VERSION) return process.env.VITE_APP_VERSION;
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unversioned-build';
  }
}

const config = {
  plugins: [react(), tailwindcss(), offlineBundle()],
  define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(buildRevision()) },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
};

export default defineConfig(config);
