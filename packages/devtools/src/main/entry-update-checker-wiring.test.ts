/**
 * Production main-process entry (`src/main/index.ts`) is the ONLY place that
 * decides whether the standalone, GitHub-Releases-distributed app checks for
 * its own updates. `WorkbenchAppConfig.updateChecker` is optional and
 * `UpdateManager` (see `services/update/update-manager.ts`) only activates —
 * registers its IPC handlers and the periodic check — when a checker is
 * supplied. A bare `launch()` with no config (as this entry previously had)
 * leaves that feature permanently dark in the packaged app, even though the
 * checker + UI were fully implemented and covered by e2e (`e2e/update-entry.js`).
 *
 * Gated on `app.isPackaged` (repo convention for dev-only behavior, see
 * `app.ts` / `bootstrap.ts`) so `pnpm dev` never hits the GitHub API or shows
 * the update dialog against a locally-built version.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const state = vi.hoisted(() => ({ isPackaged: false, version: '0.4.0' }))

vi.mock('electron', () => ({
  app: {
    get isPackaged() { return state.isPackaged },
    getVersion: () => state.version,
    exit: vi.fn(),
  },
}))

const launchMock = vi.hoisted(() => vi.fn((_config?: { updateChecker?: unknown }) => Promise.resolve()))
vi.mock('./app/launch.js', () => ({
  launch: launchMock,
  buildDefaultMenu: () => {},
  openSettingsWindow: () => Promise.resolve(),
}))

const createGitHubReleaseCheckerMock = vi.hoisted(() =>
  vi.fn((opts: unknown) => ({ __checker: true, opts })),
)
vi.mock('./services/update/index.js', () => ({
  createGitHubReleaseChecker: createGitHubReleaseCheckerMock,
}))

beforeEach(() => {
  vi.resetModules()
  state.isPackaged = false
  state.version = '0.4.0'
  launchMock.mockClear()
  createGitHubReleaseCheckerMock.mockClear()
})

describe('main entry: standalone update-checker wiring', () => {
  it('packaged RELEASE-channel build (no -dev. suffix): launch() receives a GitHub-release updateChecker for EchoTechFE/dimina-kit', async () => {
    state.isPackaged = true
    state.version = '0.4.0'

    await import('./index.js')

    // versionScheme must stay unset (default 'semver'): 'trailing-number' would
    // compare the release tag's `-N` counter against app.getVersion() and
    // report an update on every single check forever (see index.ts comment).
    expect(createGitHubReleaseCheckerMock).toHaveBeenCalledTimes(1)
    const checkerOpts = createGitHubReleaseCheckerMock.mock.calls[0]?.[0] as {
      owner: string
      repo: string
      versionScheme?: string
      parseVersion?: (release: { assets: Array<{ name: string }> }) => string | null
    }
    expect(checkerOpts).toMatchObject({ owner: 'EchoTechFE', repo: 'dimina-kit' })
    expect(checkerOpts.versionScheme).toBeUndefined()

    // parseVersion must extract a clean x.y.z from this repo's own asset
    // naming (`dimina-devtools-<ver>-<platform>-<arch>.<ext>`), not the
    // built-in fallback's SEMVER_RE — that regex's optional prerelease-suffix
    // capture greedily swallows the trailing `-mac-arm64.dmg` and would show
    // a garbled "0.5.0-mac-arm64.dmg" in the update dialog.
    expect(checkerOpts.parseVersion).toBeInstanceOf(Function)
    expect(
      checkerOpts.parseVersion!({ assets: [{ name: 'dimina-devtools-0.5.0-mac-arm64.dmg' }] }),
    ).toBe('0.5.0')
    expect(
      checkerOpts.parseVersion!({ assets: [{ name: 'dimina-devtools-0.5.0-win-x64.zip' }] }),
    ).toBe('0.5.0')
    expect(checkerOpts.parseVersion!({ assets: [{ name: 'unrelated-asset.txt' }] })).toBeNull()

    expect(launchMock).toHaveBeenCalledTimes(1)
    const config = launchMock.mock.calls[0]?.[0]
    // Identity, not just truthiness — passing some other truthy value under
    // `updateChecker` would satisfy toBeDefined() without actually wiring the
    // factory's checker through to launch().
    expect(config?.updateChecker).toBe(createGitHubReleaseCheckerMock.mock.results[0]?.value)
  })

  it('packaged DEV-channel build (-dev.<timestamp> suffix): launch() gets no updateChecker', async () => {
    // release.yml's dev channel never creates a GitHub Release — /releases/latest
    // always reflects the release channel — so a dev build must not be
    // prompted to "update" to an unrelated stable build (and silently swap
    // out the branch/PR build it was downloaded to test).
    state.isPackaged = true
    state.version = '0.4.1-dev.20260716123738'

    await import('./index.js')

    expect(createGitHubReleaseCheckerMock).not.toHaveBeenCalled()
    expect(launchMock).toHaveBeenCalledTimes(1)
    const config = launchMock.mock.calls[0]?.[0]
    expect(config?.updateChecker).toBeUndefined()
  })

  it('pnpm dev (unpackaged) run: launch() gets no updateChecker — no GitHub API calls, no update dialog', async () => {
    state.isPackaged = false

    await import('./index.js')

    expect(createGitHubReleaseCheckerMock).not.toHaveBeenCalled()
    expect(launchMock).toHaveBeenCalledTimes(1)
    const config = launchMock.mock.calls[0]?.[0]
    expect(config?.updateChecker).toBeUndefined()
  })
})
