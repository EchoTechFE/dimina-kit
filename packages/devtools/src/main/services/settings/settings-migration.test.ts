/**
 * `loadWorkbenchSettings()` migration contract from the legacy single
 * `compile.watch` flag to the split `compile.autoBuild` (recompile on file
 * change) + `preview.autoReload` (reload the simulator webview once a
 * rebuild lands) settings.
 *
 * Rules under test:
 *  - A NEW-shape file (`compile.autoBuild` + `preview.autoReload` present)
 *    is returned verbatim for those fields.
 *  - A LEGACY-shape file (`compile.watch` only, no `autoBuild`, no
 *    `preview` block) maps `watch` -> `autoBuild` and defaults
 *    `preview.autoReload` to `true` (the old always-reload behavior).
 *  - When BOTH `compile.autoBuild` and the legacy `compile.watch` are
 *    present, `autoBuild` wins.
 *  - A missing/unreadable settings file falls back to
 *    `{ compile: { autoBuild: true }, preview: { autoReload: true } }`.
 *
 * Pattern lifted from `workspace-hot-reload.test.ts`: hoist mock state so
 * `vi.mock('electron', …)` / `vi.mock('fs', …)` can see it, then lazily
 * import `loadWorkbenchSettings` after the mocks are installed so each test
 * can swap in its own fixture before the module (and its `app.getPath` /
 * `fs.readFileSync` calls) run.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => {
  const app = {
    getPath: vi.fn(() => '/tmp/dimina-test-userdata'),
    isPackaged: true,
  }
  const nativeTheme = { themeSource: 'system' }
  return { app, nativeTheme, default: {} }
})

const { readFileSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
}))

vi.mock('fs', async () => {
  const real = await vi.importActual<typeof import('fs')>('fs')
  const mocked = {
    ...real,
    readFileSync: readFileSyncMock,
  }
  return { ...mocked, default: mocked }
})

async function loadWithFixture(json: unknown): ReturnType<typeof loadFresh> {
  readFileSyncMock.mockReset()
  readFileSyncMock.mockReturnValue(JSON.stringify(json))
  return loadFresh()
}

async function loadWithMissingFile(): ReturnType<typeof loadFresh> {
  readFileSyncMock.mockReset()
  readFileSyncMock.mockImplementation(() => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  })
  return loadFresh()
}

async function loadFresh() {
  vi.resetModules()
  const { loadWorkbenchSettings } = await import('./index.js')
  return loadWorkbenchSettings()
}

describe('loadWorkbenchSettings: compile.watch -> compile.autoBuild + preview.autoReload migration', () => {
  it('returns compile.autoBuild and preview.autoReload verbatim from a new-shape file', async () => {
    const settings = await loadWithFixture({
      compile: { autoBuild: false },
      preview: { autoReload: false },
    })
    expect(settings.compile.autoBuild).toBe(false)
    expect(settings.preview.autoReload).toBe(false)
  })

  it('maps legacy compile.watch to compile.autoBuild and defaults preview.autoReload to true', async () => {
    const settingsWatchTrue = await loadWithFixture({ compile: { watch: true } })
    expect(settingsWatchTrue.compile.autoBuild).toBe(true)
    expect(settingsWatchTrue.preview.autoReload).toBe(true)

    const settingsWatchFalse = await loadWithFixture({ compile: { watch: false } })
    expect(settingsWatchFalse.compile.autoBuild).toBe(false)
    expect(settingsWatchFalse.preview.autoReload).toBe(true)
  })

  it('prefers new compile.autoBuild over legacy compile.watch when both are present', async () => {
    const settings = await loadWithFixture({
      compile: { autoBuild: true, watch: false },
      preview: { autoReload: false },
    })
    expect(settings.compile.autoBuild).toBe(true)
    expect(settings.preview.autoReload).toBe(false)
  })

  it('defaults to autoBuild:true and autoReload:true when the settings file is missing or unreadable', async () => {
    const settings = await loadWithMissingFile()
    expect(settings.compile.autoBuild).toBe(true)
    expect(settings.preview.autoReload).toBe(true)
  })

  it('coerces non-boolean values (hand-edited / corrupt config) to real booleans, not truthy strings', async () => {
    // A `??` chain only guards null/undefined: a stringy "false" would pass
    // through and read as truthy downstream, silently keeping auto-build/reload
    // ON when the user meant OFF. Non-boolean must fall back to the default.
    const stringy = await loadWithFixture({
      compile: { autoBuild: 'false' },
      preview: { autoReload: 'false' },
    })
    expect(stringy.compile.autoBuild).toBe(true)
    expect(stringy.preview.autoReload).toBe(true)

    // A non-boolean new key must not shadow a valid legacy boolean either.
    const legacyWins = await loadWithFixture({ compile: { autoBuild: 'nope', watch: false } })
    expect(legacyWins.compile.autoBuild).toBe(false)
  })
})
