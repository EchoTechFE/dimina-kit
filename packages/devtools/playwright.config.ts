import { defineConfig } from '@playwright/test'

// PLAYWRIGHT_WORKERS is the explicit throughput/stress override: when set it
// replaces BOTH the top-level cap and every project's own `workers` below, so
// `PLAYWRIGHT_WORKERS=2 npx playwright test --project=native-host` behaves
// exactly like the pre-projects single-`workers` config did.
const explicitWorkers = process.env.PLAYWRIGHT_WORKERS ? Number(process.env.PLAYWRIGHT_WORKERS) : undefined

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // File-parallel via workers; within-file serial (Playwright default when
  // fullyParallel is false). Each worker owns one Electron + one user-data-dir.
  fullyParallel: false,
  // Top-level cap on TOTAL concurrent workers across all projects. Playwright
  // schedules the projects below concurrently, so this — not any single
  // project's own `workers` — is what bounds peak memory.
  //
  // This is an empirical ceiling, not the sum of the per-project caps. On a
  // 10-core/16GB machine a full 262-test run was OOM-killed by the OS at 6
  // (97 tests in) and again at 3 (194 tests in) — in both cases the suite was
  // otherwise healthy, so the limit is host memory, not test correctness.
  // A 26-test subset of the shared-fixture project alone did fit at 3
  // (~4.8GB RSS / ~39 processes); the full suite mixes in the heavier
  // native-host double-WebContents files and does not. Raise only with a
  // completed full run and a fresh memory measurement.
  //
  // CI stays serial; PLAYWRIGHT_WORKERS overrides everything uniformly (see
  // `explicitWorkers` above) for an explicit throughput/stress run.
  workers: process.env.CI ? 1 : (explicitWorkers ?? 2),
  retries: process.env.CI ? 2 : 0,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'native-host',
      // Each worker owns a full Electron runtime, and DIMINA_NATIVE_HOST=1
      // mode adds a SECOND WebContents layer per window (service host +
      // render guest, see native-host-devtools-elements.spec.ts) — the
      // cold-boot phase is a heavier CPU/IO contention window than the other
      // two projects. Local file-parallel runs here can starve new Electron
      // launches and leave firstWindow() waiting forever, so no two files in
      // THIS project ever run at once.
      //
      // A per-project cap alone is NOT equivalent to the pre-sharding global
      // `workers: 1` — it stops this project from running two of its own
      // files at once, but the other two projects still run alongside it. That
      // was measured, not assumed: with all three overlapping, home-button's
      // simulator-webview wait blew its 30s budget while the same file passed
      // serially in 20.5s. Hence `dependencies` on the other two: this project
      // runs alone first, under exactly the old conditions, and only then do
      // the two lighter projects start.
      workers: explicitWorkers ?? 1,
      testMatch: [
        'device-frame-integration.spec.ts',
        'home-button-no-tabbar.spec.ts',
        'home-button.spec.ts',
        'native-host-console-project-switch.spec.ts',
        'native-host-current-page.spec.ts',
        'native-host-devtools-console.spec.ts',
        'native-host-devtools-elements-navigate.spec.ts',
        'native-host-devtools-elements-respawn.spec.ts',
        'native-host-navigate-after-relaunch.spec.ts',
        'native-host-network-response-body.spec.ts',
        'native-host-open-in-editor.spec.ts',
        'native-host-render.spec.ts',
        'native-host-websocket-contract.spec.ts',
        'native-host-websocket-panel.spec.ts',
        'native-host-wxml-highlight.spec.ts',
        'window-info-follows-device.spec.ts',
        'native-host-nh1.spec.ts',
      ],
    },
    {
      name: 'custom-launch-light',
      // Every file here launches its own Electron instance in beforeAll, but
      // without the native-host double-WebContents layer — structurally
      // lighter at cold-boot than the native-host project. NOT empirically
      // load-tested at workers>1 in this pass (only the shared-fixture
      // project below was); kept at a conservative 2 pending a dedicated
      // verification run. Drop to 1 if it turns out to reproduce the same
      // firstWindow() starvation as native-host.
      workers: explicitWorkers ?? 2,
      // Starts only after native-host is done — see that project's comment.
      dependencies: ['native-host'],
      testMatch: [
        'automator-compat.spec.ts',
        'automator-label-semantics.spec.ts',
        'console-filter-live.spec.ts',
        'dialog-zorder.spec.ts',
        'dock-consolidation-smoke.spec.ts',
        'dock-devtools-position-preset.spec.ts',
        'dock-keepalive-and-collapse.spec.ts',
        'dock-real-drag.spec.ts',
        'dock-resize-sync-regressions.spec.ts',
        'dock-resize-sync-regressions2.spec.ts',
        'dock-resize-sync.spec.ts',
        'dock-separator-drag.spec.ts',
        'dock-tab-reorder.spec.ts',
        'extension-host.spec.ts',
        'failure-behaviors.spec.ts',
        'host-dialog.spec.ts',
        'host-sidebar.spec.ts',
        'host-toolbar-lifecycle.spec.ts',
        'host-toolbar-port.spec.ts',
        'host-toolbar-replay.spec.ts',
        'host-toolbar.spec.ts',
        'internal-devtools-console-reopen.spec.ts',
        'qdml-filetypes.spec.ts',
        'standalone-devtools-flood-cold-start.spec.ts',
        'standalone-devtools-window-churn.spec.ts',
        'update-dialog.spec.ts',
        'workbench-backend.spec.ts',
      ],
    },
    {
      name: 'shared-fixture',
      // Electron cold-starts equal the WORKER count here, not the file count:
      // fixtures.ts's `electronApp` fixture is worker-scoped, so every file a
      // given worker picks up reuses that worker's single already-launched
      // instance. Empirically verified: an 8-file/26-test subset of this
      // project (app-launch, appdata-edit, broken-project, compile-mode-ux,
      // console-filter-reset, device-picker-overlay, devtools-panel,
      // devtools-tab-order) passed cleanly with zero failures/flakes and no
      // leftover Electron processes at both workers:2 (73.9s) and workers:3
      // (86.9s, peak ~4.8GB RSS across ~39 Electron-related processes) —
      // 2026-09-07, this machine. relaunch-resilience is the longest file in
      // the whole suite (131s/6 tests); it's included below like every other
      // member, but watch it first if this project's shard balance ever
      // needs manual tuning.
      workers: explicitWorkers ?? 3,
      // Starts only after native-host is done — see that project's comment.
      dependencies: ['native-host'],
      testMatch: [
        'app-launch.spec.ts',
        'appdata-edit.spec.ts',
        'broken-project.spec.ts',
        'compile-mode-ux.spec.ts',
        'console-filter-reset.spec.ts',
        'device-picker-overlay.spec.ts',
        'devtools-panel.spec.ts',
        'devtools-tab-order.spec.ts',
        'disk-sync.spec.ts',
        'editor-hot-reload.spec.ts',
        'editor-project-switch.spec.ts',
        'editor-theme-boot-no-white-flash.spec.ts',
        'extension-panels.spec.ts',
        'internal-devtools-window.spec.ts',
        'ipc-workflow.spec.ts',
        'minigame-launch.spec.ts',
        'panel-switching.spec.ts',
        'project-card-proportions.spec.ts',
        'project-edit.spec.ts',
        'project-list-category.spec.ts',
        'relaunch-resilience.spec.ts',
        'settings.spec.ts',
        'toolbar-visual.spec.ts',
        'wal-audit.spec.ts',
      ],
    },
  ],
})
