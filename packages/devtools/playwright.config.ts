import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // File-parallel via workers; within-file serial (Playwright default when
  // fullyParallel is false). Each worker owns one Electron + one user-data-dir.
  fullyParallel: false,
  // Each worker owns an isolated Electron + --user-data-dir and its windows are
  // moved off-screen + blurred (see fixtures.launchElectron), so workers don't
  // contend over singleton locks or steal focus. Locally we run 3 in parallel
  // for throughput; override with PLAYWRIGHT_WORKERS if a machine is constrained.
  workers: process.env.CI
    ? 1
    : process.env.PLAYWRIGHT_WORKERS
      ? Number(process.env.PLAYWRIGHT_WORKERS)
      : 3,
  retries: process.env.CI ? 2 : 0,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
})
