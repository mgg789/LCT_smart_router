import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

// Tests reset the database. Only the private Compose service names are accepted.
if (
  process.env.E2E_ISOLATED !== 'true' ||
  process.env.E2E_BASE_URL !== 'http://localhost' ||
  process.env.E2E_API_URL !== 'http://api:8000'
) {
  throw new Error('Run pnpm test:regression: browser tests require the disposable Compose contour');
}

const phase = process.env.E2E_PHASE ?? 'browser';
if (!['browser', 'router-down', 'router-recovery'].includes(phase)) {
  throw new Error('Unknown regression phase');
}
const phaseArtifacts = resolve('artifacts', phase);

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  grep: phase === 'browser' ? undefined : new RegExp(`@${phase}`),
  grepInvert: phase === 'browser' ? /@router-/ : undefined,
  outputDir: resolve(phaseArtifacts, 'test-results'),
  reporter: [
    ['list'],
    ['html', { outputFolder: resolve(phaseArtifacts, 'playwright-report'), open: 'never' }],
    ['junit', { outputFile: resolve(phaseArtifacts, 'junit.xml') }],
  ],
  use: {
    baseURL: process.env.E2E_BASE_URL,
    browserName: 'chromium',
    // The private CI contour has no GPU; render real WebGL maps with software GL.
    launchOptions: {
      args: ['--use-gl=angle', '--use-angle=swiftshader'],
    },
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: 'block',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
