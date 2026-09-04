/**
 * Contract: the default compilation adapter must stop asking devkit's
 * `openProject` to build under a single flat `outputDir` (name-collision risk
 * across projects with the same appid) and instead pass `outputRoot` —
 * `<userData>/dimina-fe-output` — letting devkit key each project's artifacts
 * onto its own hashed subdirectory.
 *
 * Electron mock: only `app.getPath` is exercised here, copied down from the
 * fuller stub in open-settings-wiring.test.ts. `@dimina-kit/devkit` is
 * mocked so the assertion reads the exact options object the adapter built,
 * without spinning up a real compile.
 */
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/dimina-test-userdata'),
  },
}))

const devkitOpenProject = vi.hoisted(() => vi.fn((_opts: Record<string, unknown>) => Promise.resolve({
  port: 0,
  appInfo: { appId: 'unknown', name: 'x', path: '/tmp/proj' },
  rebuild: () => Promise.resolve(),
  close: () => Promise.resolve(),
})))

vi.mock('@dimina-kit/devkit', () => ({
  openProject: devkitOpenProject,
}))

beforeEach(() => {
  vi.resetModules()
  devkitOpenProject.mockClear()
})

describe('defaultAdapter.openProject: passes outputRoot, not a flat outputDir, to devkit', () => {
  it('calls devkit openProject with outputRoot = <userData>/dimina-fe-output and outputDir left undefined', async () => {
    const { defaultAdapter } = await import('./default-adapter.js')

    await defaultAdapter.openProject({ projectPath: '/tmp/some-project' })

    expect(devkitOpenProject).toHaveBeenCalledTimes(1)
    const opts = devkitOpenProject.mock.calls[0]![0] as Record<string, unknown>

    expect(
      opts.outputRoot,
      'the adapter must key artifacts onto a per-project subdirectory via outputRoot, not a single shared outputDir',
    ).toBe(path.join('/tmp/dimina-test-userdata', 'dimina-fe-output'))

    expect(
      opts.outputDir,
      'outputDir and outputRoot are mutually exclusive in devkit — passing both makes openProject reject',
    ).toBeUndefined()
  })
})
