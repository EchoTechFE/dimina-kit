/**
 * Production main-process entry (`src/main/index.ts`) must not let a rejected
 * `launch()` escape as an unhandledRejection.
 *
 * `index.ts` is the bundled electron main entry; it boots the app by calling
 * `launch()` (which returns a Promise — the electron-deck whenReady gate).
 * If `launch()` rejects (real cause that motivated this: WorkbenchApp.start()
 * without a whenReady gate crashing on a real machine) the entry must have a
 * STRUCTURED failure exit — the rejection must be caught and surfaced
 * (logged / process exit), NOT left to float as a process `unhandledRejection`
 * which gives no diagnostics and can be swallowed.
 *
 * This test fails an entry that does a bare `launch()` (no `.catch`): the
 * rejection reaches the process `unhandledRejection` handler.
 *
 * Harness: we `vi.mock('./app/launch.js')` so `launch` returns a rejected
 * promise, install our own `process.on('unhandledRejection')` probe, import the
 * entry module, then let the microtask queue + a macrotask drain so any
 * unhandled rejection is reported by Node before we assert.
 */
import { describe, it, expect, vi } from 'vitest'

// Sentinel error the mocked launch() rejects with; we only care about THIS one
// reaching (or not reaching) the unhandledRejection probe.
const LAUNCH_FAILURE = new Error('launch() boot failure (test sentinel)')

// NOTE: `launch` is a PLAIN function, not a `vi.fn`. Vitest's spy wrapper
// tracks the returned promise's settled state (it attaches a .then/.catch to
// fill `mock.results`), which would itself "handle" the rejection and mask the
// very escape this test is checking for. A plain function leaves the rejected
// promise exactly as the real entry sees it: discarded and unhandled unless the
// entry attaches its own `.catch`.
vi.mock('./app/launch.js', () => ({
  launch: () => Promise.reject(LAUNCH_FAILURE),
  buildDefaultMenu: () => {},
  openSettingsWindow: () => Promise.resolve(),
}))

// The entry's structured failure exit imports `app` from electron (app.exit).
// CI has no electron binary — importing the real package throws in
// getElectronPath — so main-process tests must mock electron (repo convention).
vi.mock('electron', () => ({
  app: { exit: () => undefined },
}))

// Some structured-failure exits call process.exit / console.error. Keep the
// process alive and capture the error output so a fixed entry doesn't tear the
// test runner down or spew.
vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => undefined) as never)
vi.spyOn(console, 'error').mockImplementation(() => {})

// Drain microtasks (promise callbacks) and one macrotask turn, which is when
// Node emits 'unhandledRejection' for a promise that ended its tick rejected
// with no handler attached.
async function drainRejections(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setImmediate(resolve))
}

describe('main entry: a rejected launch() must not become an unhandledRejection', () => {
  it('catches / handles the launch rejection (structured failure exit)', async () => {
    const unhandled: unknown[] = []
    const probe = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', probe)
    try {
      // Import the real production entry; it synchronously calls the mocked
      // launch(), which returns a rejected promise.
      await import('./index.js')
      await drainRejections()
    } finally {
      process.off('unhandledRejection', probe)
    }

    // ── PINNED ASSERTION ──────────────────────────────────────────────────
    // The entry's launch() rejection must be handled. A bare `launch()` with no
    // `.catch` lets LAUNCH_FAILURE reach this probe.
    expect(
      unhandled,
      'launch() rejection escaped as an unhandledRejection — the entry has no structured failure exit',
    ).not.toContain(LAUNCH_FAILURE)
  })
})
