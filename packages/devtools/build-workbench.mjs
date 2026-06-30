#!/usr/bin/env node

/**
 * Build the VS Code workbench app into devtools' dist/vscode-workbench.
 *
 * The workbench package reads `WORKBENCH_OUT_DIR` (vite.config.ts) to redirect
 * its bundle here. Setting that env var inline (`WORKBENCH_OUT_DIR=… pnpm …`)
 * only works in POSIX shells, so the Windows release build failed with
 * "'WORKBENCH_OUT_DIR' is not recognized". This wrapper sets it in
 * `process.env` and spawns the filtered build, so it works on every platform.
 */

import { spawnSync } from 'node:child_process'

const result = spawnSync(
  'pnpm',
  ['--filter', '@dimina-kit/workbench', 'run', 'build:app'],
  {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, WORKBENCH_OUT_DIR: '../devtools/dist/vscode-workbench' },
  },
)
if (result.status !== 0) process.exit(result.status ?? 1)
