/**
 * Contract: `getProjectPages` must not fail silently.
 *
 * Today the catch block in `project-repository.ts`'s `getProjectPages` is:
 *   `catch { return { pages: [], entryPagePath: '' } }`
 * — a missing/unparseable app.json (deleted project, corrupted file, race
 * with a mid-write watcher) is swallowed with zero trace. The renderer then
 * just shows an empty pages list with no indication anything went wrong,
 * indistinguishable from "this project legitimately has no pages".
 *
 * Fix under test: the catch path must still return the same `{ pages: [],
 * entryPagePath: '' }` shape (callers must not change), but must ALSO
 * `console.warn` once with a message containing the `projectPath` so a
 * developer/host can see WHICH project failed to read. The success path
 * must not warn.
 */
import path from 'path'
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/dimina-test-userdata') },
  default: { app: { getPath: () => '/tmp/dimina-test-userdata' } },
}))

const fsState = vi.hoisted(() => {
  const files = new Map<string, string>()
  function reset() { files.clear() }
  return { files, reset }
})

vi.mock('fs', async () => {
  const real = await vi.importActual<typeof import('fs')>('fs')
  function existsSync(p: import('fs').PathLike): boolean {
    return fsState.files.has(String(p))
  }
  function readFileSync(p: import('fs').PathOrFileDescriptor): string {
    const s = String(p)
    if (!fsState.files.has(s)) {
      throw Object.assign(new Error('ENOENT: ' + s), { code: 'ENOENT' })
    }
    return fsState.files.get(s)!
  }
  const mocked = { ...real, existsSync, readFileSync, default: undefined as unknown }
  ;(mocked as { default: unknown }).default = mocked
  return mocked
})

let getProjectPages: typeof import('./project-repository.js').getProjectPages
let warnSpy: MockInstance<typeof console.warn>

beforeEach(async () => {
  fsState.reset()
  vi.resetModules()
  ;({ getProjectPages } = await import('./project-repository.js'))
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
})

describe('getProjectPages — failure path must warn instead of failing silently', () => {
  it('returns the empty-shape fallback AND warns with the projectPath when app.json is missing', () => {
    const projectPath = '/projects/does-not-exist'

    const result = getProjectPages(projectPath)

    expect(result).toEqual({ pages: [], entryPagePath: '' })
    expect(
      warnSpy,
      'a failed app.json read must be surfaced via console.warn, not swallowed silently',
    ).toHaveBeenCalled()
    const warned = warnSpy.mock.calls.some((call: unknown[]) =>
      call.some((arg) => typeof arg === 'string' && arg.includes(projectPath)),
    )
    expect(warned, 'the warning must name which project failed to read').toBe(true)
  })

  it('returns the empty-shape fallback AND warns when app.json exists but is not valid JSON', () => {
    const projectPath = '/projects/corrupt'
    fsState.files.set(path.join(projectPath, 'app.json'), '{ not valid json')

    const result = getProjectPages(projectPath)

    expect(result).toEqual({ pages: [], entryPagePath: '' })
    expect(warnSpy).toHaveBeenCalled()
  })

  it('does NOT warn on the success path', () => {
    const projectPath = '/projects/ok'
    fsState.files.set(
      path.join(projectPath, 'app.json'),
      JSON.stringify({ pages: ['pages/index/index'], entryPagePath: 'pages/index/index' }),
    )

    const result = getProjectPages(projectPath)

    expect(result).toEqual({ pages: ['pages/index/index'], entryPagePath: 'pages/index/index' })
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
