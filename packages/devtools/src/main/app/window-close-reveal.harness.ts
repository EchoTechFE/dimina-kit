/**
 * Shared vitest mock harness for the list/workbench-window close-guard test
 * files (`main-window-close-guard.test.ts`, `workbench-window-reveal-on-
 * close.test.ts`, and siblings) — all drive the REAL `createDevtoolsRuntime`
 * against the electron/fs/`@dimina-kit/devkit` mock set defined in
 * `../runtime/devtools-runtime-mock.harness.ts`, plus the runtime-lifecycle
 * and window-opening helpers below that those tests need in common.
 *
 * `vi.mock(...)` calls in the imported core module run once per importing
 * test file's own isolated module graph (vitest scopes mocking per test
 * file); chaining through this module has the same effect as if they were
 * written directly in the importing file.
 */
import { beforeEach, vi } from 'vitest'
import { stubs, devkitStubs } from '../runtime/devtools-runtime-mock.harness.js'

export { stubs, devkitStubs } from '../runtime/devtools-runtime-mock.harness.js'

/**
 * Shared per-test setup: reset modules (fresh module-level state each test),
 * reset the mock harness above, and dynamically re-import `electron` +
 * `createDevtoolsRuntime` + the lifecycle flag — dynamic, not a static
 * top-level import, because it must happen AFTER `vi.resetModules()` picks
 * up a fresh module instance each test. Registers its own `beforeEach`; call
 * once per describing test file.
 */
export interface RuntimeTestState {
  createDevtoolsRuntime: typeof import('./app.js').createDevtoolsRuntime
  registerAppLifecycle: typeof import('./lifecycle.js').registerAppLifecycle
  isAppQuitting: typeof import('./lifecycle.js').isAppQuitting
  electron: typeof import('electron')
}

export function registerRuntimeTestLifecycle(): RuntimeTestState {
  const state = {} as RuntimeTestState
  beforeEach(async () => {
    vi.resetModules()
    stubs.reset()
    devkitStubs.sessionClose.mockClear()
    state.electron = await import('electron')
    ;({ createDevtoolsRuntime: state.createDevtoolsRuntime } = await import('./app.js'))
    ;({ registerAppLifecycle: state.registerAppLifecycle, isAppQuitting: state.isAppQuitting } =
      await import('./lifecycle.js'))
  })
  return state
}

/**
 * Registers `projectDir` as an openable project (app.json present, empty
 * projects list) and opens it in its own window via the real
 * `openProjectWindow`. Does NOT open a devkit session — the close guards
 * under test branch on window-list membership, not session state (teardown
 * is unconditional; see workbench-window.ts's `wireWorkbenchWindowEvents`
 * doc comment), so a session adds cost without adding coverage here.
 */
export async function openProjectWindow(
  instance: Awaited<ReturnType<typeof import('./app.js').createDevtoolsRuntime>>,
  projectDir: string,
): Promise<ReturnType<Awaited<ReturnType<typeof import('./app.js').createDevtoolsRuntime>>['projectWindows']>[number]> {
  stubs.projectsWithAppJson.add(projectDir)
  if (stubs.getProjectsJson() === null) stubs.setProjectsJson(JSON.stringify([]))
  await instance.openProjectWindow({ path: projectDir })
  // The manager keys its window map by project path and this helper always
  // opens a path it just registered, so the newest entry is the one that was
  // asked for. Matching on anything weaker (e.g. "the first window that isn't
  // the list window") hands back the PREVIOUSLY opened project once a second
  // one is open, which is exactly the multi-window case these tests exist for.
  const found = instance.projectWindows().at(-1)
  if (!found) throw new Error(`openProjectWindow(${projectDir}) did not publish a window`)
  return found
}

/** A fresh Electron-shaped close event, plus a getter for whether it was prevented. */
export function makeCloseEvent(): { event: { preventDefault: () => void }; prevented: () => boolean } {
  let count = 0
  return {
    event: { preventDefault: () => { count += 1 } },
    prevented: () => count > 0,
  }
}

export function emitClose(win: unknown, event: unknown): void {
  ;(win as { emit: (event: string, ...args: unknown[]) => void }).emit('close', event)
}
