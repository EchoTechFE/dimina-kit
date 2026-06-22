/**
 * Session-resident toolbar-runtime preload: GUARD + ACTIVATION.
 *
 * The runtime is registered on session.defaultSession via
 * `registerPreloadScript({ type: 'frame', … })`, so it executes in EVERY
 * defaultSession renderer — the main window, settings/popover overlays, and
 * (with nodeIntegrationInSubFrames) even subframes. The `additionalArguments`
 * marker is PROCESS-level (subframes of the toolbar window see it too), so the
 * guard needs BOTH wings — `isMainFrame` AND `argv.includes(marker)` — and a
 * window without the marker still runs the preload but must leave zero
 * footprint.
 *
 * Contract under test (module `./host-toolbar-runtime.ts`):
 *   - `shouldActivateHostToolbarRuntime(argv, isMainFrame): boolean` — pure
 *     guard predicate, marker literal `'--dimina-host-toolbar'`.
 *   - `activateHostToolbarRuntime({ argv, isMainFrame }): boolean` — runs the
 *     guard; only when it passes installs the height advertiser
 *     (`installHostToolbarAdvertiserWhenReady`); returns whether it activated.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  ipcRenderer: { send: vi.fn(), on: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
}))

vi.mock('./host-toolbar-advertiser.js', () => ({
  installHostToolbarAdvertiser: vi.fn(() => () => {}),
  installHostToolbarAdvertiserWhenReady: vi.fn(),
}))

/** The marker main injects via webPreferences.additionalArguments. */
const MARKER = '--dimina-host-toolbar'

/** Realistic Chromium renderer argv noise around the marker. */
const TOOLBAR_ARGV = [
  '/Applications/Electron.app/Contents/MacOS/Electron Helper (Renderer)',
  '--type=renderer',
  '--app-path=/stub/app',
  MARKER,
  '--renderer-client-id=7',
]
const NO_MARKER_ARGV = TOOLBAR_ARGV.filter((a) => a !== MARKER)

type RuntimeModule = {
  shouldActivateHostToolbarRuntime: (argv: readonly string[], isMainFrame: boolean) => boolean
  activateHostToolbarRuntime: (env: { argv: readonly string[]; isMainFrame: boolean }) => boolean
}

const RUNTIME_MODULE = './host-toolbar-runtime.js'
async function loadRuntime(): Promise<RuntimeModule> {
  // Non-literal specifier keeps the import out of TS's static resolution at
  // check-types time.
  return (await import(/* @vite-ignore */ `${RUNTIME_MODULE}`)) as RuntimeModule
}

async function advertiserMock() {
  const mod = await import('./host-toolbar-advertiser.js')
  return vi.mocked(mod.installHostToolbarAdvertiserWhenReady)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('guard predicate (both wings)', () => {
  it('activates for a main frame whose argv carries the marker', async () => {
    // Positive control — if this is false the toolbar window itself never
    // gets its advertiser and the strip height stays 0.
    const { shouldActivateHostToolbarRuntime } = await loadRuntime()
    expect(shouldActivateHostToolbarRuntime(TOOLBAR_ARGV, true)).toBe(true)
  })

  it('rejects a main frame WITHOUT the marker (every other defaultSession window)', async () => {
    // The session preload runs in the main window / settings / popover too,
    // with hasMarker=false. Without marker rejection the advertiser installs
    // there and starts measuring arbitrary app DOM.
    const { shouldActivateHostToolbarRuntime } = await loadRuntime()
    expect(shouldActivateHostToolbarRuntime(NO_MARKER_ARGV, true)).toBe(false)
  })

  it('rejects a subframe even WITH the marker (marker is process-level, frame-indistinguishable)', async () => {
    // A subframe inside the toolbar window has the SAME argv (hasMarker=true,
    // isMainFrame=false). Marker alone cannot stop it; dropping the isMainFrame
    // wing double-installs the advertiser the moment toolbar content embeds an
    // iframe with nodeIntegrationInSubFrames.
    const { shouldActivateHostToolbarRuntime } = await loadRuntime()
    expect(shouldActivateHostToolbarRuntime(TOOLBAR_ARGV, false)).toBe(false)
  })

  it('rejects when both wings fail', async () => {
    const { shouldActivateHostToolbarRuntime } = await loadRuntime()
    expect(shouldActivateHostToolbarRuntime(NO_MARKER_ARGV, false)).toBe(false)
  })
})

describe('activation flow (guard gates the advertiser install)', () => {
  it('eligible env: installs the height advertiser exactly once and reports activation', async () => {
    const { activateHostToolbarRuntime } = await loadRuntime()
    const install = await advertiserMock()

    const activated = activateHostToolbarRuntime({ argv: TOOLBAR_ARGV, isMainFrame: true })

    expect(activated).toBe(true)
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('no marker: returns without installing ANYTHING (zero footprint in non-toolbar windows)', async () => {
    // In the main window the runtime must early-return — no advertiser, no
    // listeners, no globals.
    const { activateHostToolbarRuntime } = await loadRuntime()
    const install = await advertiserMock()

    const activated = activateHostToolbarRuntime({ argv: NO_MARKER_ARGV, isMainFrame: true })

    expect(activated).toBe(false)
    expect(install).not.toHaveBeenCalled()
  })

  it('subframe: returns without installing', async () => {
    const { activateHostToolbarRuntime } = await loadRuntime()
    const install = await advertiserMock()

    const activated = activateHostToolbarRuntime({ argv: TOOLBAR_ARGV, isMainFrame: false })

    expect(activated).toBe(false)
    expect(install).not.toHaveBeenCalled()
  })
})
