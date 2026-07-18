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

const state = vi.hoisted(() => ({ isPackaged: false }))

vi.mock('electron', () => ({
  app: {
    get isPackaged() { return state.isPackaged },
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
  launchMock.mockClear()
  createGitHubReleaseCheckerMock.mockClear()
})

describe('main entry: standalone update-checker wiring', () => {
  it('packaged app: launch() receives a GitHub-release updateChecker for EchoTechFE/dimina-kit', async () => {
    state.isPackaged = true

    await import('./index.js')

    expect(createGitHubReleaseCheckerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'EchoTechFE',
        repo: 'dimina-kit',
        versionScheme: 'trailing-number',
      }),
    )
    expect(launchMock).toHaveBeenCalledTimes(1)
    const config = launchMock.mock.calls[0]?.[0]
    expect(config?.updateChecker).toBeDefined()
  })

  it('dev (unpackaged) run: launch() gets no updateChecker — no GitHub API calls, no update dialog', async () => {
    state.isPackaged = false

    await import('./index.js')

    expect(createGitHubReleaseCheckerMock).not.toHaveBeenCalled()
    expect(launchMock).toHaveBeenCalledTimes(1)
    const config = launchMock.mock.calls[0]?.[0]
    expect(config?.updateChecker).toBeUndefined()
  })
})
