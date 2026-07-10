import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // File-parallel via workers; within-file serial (Playwright default when
  // fullyParallel is false). Each worker owns one Electron + one user-data-dir.
  fullyParallel: false,
  // Each worker owns a full Electron runtime. The native-host specs are heavy
  // enough that local file-parallel runs can starve new Electron launches and
  // leave firstWindow() waiting forever. Keep the default deterministic; use
  // PLAYWRIGHT_WORKERS for an explicit throughput/stress run.
  workers: process.env.CI
    ? 1
    : process.env.PLAYWRIGHT_WORKERS
      ? Number(process.env.PLAYWRIGHT_WORKERS)
      : 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
})
