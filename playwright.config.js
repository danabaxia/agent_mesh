// playwright.config.js — Plan 3 e2e/visual tier (NIGHTLY-ONLY, non-blocking).
//
// Runs ONLY against the provably-synthetic fixture server (test/e2e/
// fixture-server.mjs), never a real mesh. Tuned for deterministic CI rendering:
//   - single chromium project, headless, fixed viewport
//   - serialized (workers:1), retries:0 — a flaky run must be a real signal
//   - pinned maxDiffPixelRatio for visual baselines; google fonts are blocked in
//     the spec so a missing webfont can't shift pixels
//
// Baselines: on the FIRST real CI run there are no committed snapshots, so the
// visual assertion is created (and the run is marked non-blocking in
// integration.yml). Regenerate intentionally with `npm run test:e2e -- --update-snapshots`.
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT || 7099);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './test/e2e',
  testMatch: /.*\.spec\.js/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  expect: {
    // Pixel-stable visual regression: allow a tiny ratio for antialiasing jitter
    // only. A real regression moves far more than this.
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' },
  },
  use: {
    baseURL: BASE_URL,
    headless: true,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: `node test/e2e/fixture-server.mjs ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
});
