/**
 * Independent contract review of `ProjectsProvider` for downstream hosts
 * (downstream hosts). Locks down the documented "may be sync or Promise /
 * optional methods fall back to sensible defaults" contract so a remote/
 * async host implementation behaves the same as the local default.
 *
 * Each test inlines the minimal host-side glue a downstream host would write on top
 * of a provider — if the contract is ambiguous, the inline glue is the
 * natural-but-wrong way to write it.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ProjectsProvider, Project } from './index.js'

describe('ProjectsProvider — host integration contract', () => {
  /** If absent: an async listProjects would JSON-serialise as `{}` to the renderer and every row vanishes. */
  it('listProjects: sync and async impls are both awaitable without double-wrapping', async () => {
    const syncP: ProjectsProvider = {
      listProjects: () => [{ name: 'a', path: '/p/a' }],
      addProject: (p) => ({ name: 'a', path: p }),
      removeProject: () => {},
    }
    const asyncP: ProjectsProvider = {
      listProjects: async () => [{ name: 'b', path: '/p/b' }],
      addProject: async (p) => ({ name: 'b', path: p }),
      removeProject: async () => {},
    }
    const a = await Promise.resolve(syncP.listProjects())
    const b = await Promise.resolve(asyncP.listProjects())
    expect(a[0]!.path).toBe('/p/a')
    expect(b[0]!.path).toBe('/p/b')
  })

  /** If absent: a transient remote listProjects error gets swallowed as false; host re-adds an existing project as a duplicate. */
  it('hasProject derived from listProjects must surface the underlying error, not return false', async () => {
    const provider: ProjectsProvider = {
      listProjects: async () => {
        throw new Error('network down')
      },
      addProject: async (p) => ({ name: 'x', path: p }),
      removeProject: async () => {},
    }
    const hasProject = async (dir: string) =>
      (await provider.listProjects()).some((p: Project) => p.path === dir)
    await expect(hasProject('/p/x')).rejects.toThrow('network down')
  })

  /** If absent: a host omitting `validateProjectDir` crashes with TypeError on the "添加项目" click. */
  it('validateProjectDir is optional: glue must treat absence as "no error"', async () => {
    const provider: ProjectsProvider = {
      listProjects: () => [],
      addProject: (p) => ({ name: 'x', path: p }),
      removeProject: () => {},
    }
    const validate = async (dir: string) =>
      provider.validateProjectDir ? await provider.validateProjectDir(dir) : null
    await expect(validate('/some/dir')).resolves.toBeNull()
  })

  /** If absent: a host omitting `getCompileConfig` delivers `undefined` to the compile toolbar; `.startPage`/`.scene` reads blank-screen the simulator. */
  it('getCompileConfig is optional: glue must return the documented default shape on absence', async () => {
    const provider: ProjectsProvider = {
      listProjects: () => [],
      addProject: (p) => ({ name: 'x', path: p }),
      removeProject: () => {},
    }
    const DEFAULT = { startPage: '', scene: 1001, queryParams: [] as { key: string; value: string }[] }
    const getCfg = async (dir: string) =>
      provider.getCompileConfig ? await provider.getCompileConfig(dir) : DEFAULT
    const cfg = await getCfg('/p/x')
    expect(cfg).toMatchObject({ startPage: '', scene: 1001 })
    expect(Array.isArray(cfg.queryParams)).toBe(true)
  })

  /** If absent: open-project races so updateLastOpened hits the remote before addProject lands; the bump 404s and lastOpened silently never persists. */
  it('addProject must be awaited before updateLastOpened for the same path', async () => {
    const order: string[] = []
    const provider: ProjectsProvider = {
      listProjects: async () => [],
      addProject: async (p) => {
        await new Promise((r) => setTimeout(r, 5))
        order.push(`add:${p}`)
        return { name: 'x', path: p, lastOpened: null }
      },
      updateLastOpened: async (p) => {
        order.push(`bump:${p}`)
      },
      removeProject: async () => {},
    }
    await provider.addProject('/p/x')
    if (provider.updateLastOpened) await provider.updateLastOpened('/p/x')
    expect(order).toEqual(['add:/p/x', 'bump:/p/x'])
  })

  /** If absent: an un-awaited async saveCompileConfig lets the IPC reply resolve before the remote write completes; the user's edit appears to vanish on next open. */
  it('optional async writes must be awaited so callers observe completion', async () => {
    let written: unknown = null
    const provider: ProjectsProvider = {
      listProjects: () => [],
      addProject: (p) => ({ name: 'x', path: p }),
      removeProject: () => {},
      saveCompileConfig: async (_p, cfg) => {
        // Resolve on a microtask, not a real timer: the point is that callers
        // await completion, not how long the write takes.
        await Promise.resolve()
        written = cfg
      },
    }
    const cfg = { startPage: 'pages/x', scene: 1001, queryParams: [] }
    await provider.saveCompileConfig!('/p/x', cfg)
    expect(written).toEqual(cfg)
  })

  /** If absent: addProject rejection (e.g. remote 403) gets swallowed; renderer thinks the project was added, then disagrees on next listProjects refresh. */
  it('addProject rejection must propagate so the IPC layer can surface it', async () => {
    const provider: ProjectsProvider = {
      listProjects: async () => [],
      addProject: async () => {
        throw new Error('forbidden')
      },
      removeProject: async () => {},
    }
    await expect(provider.addProject('/p/x')).rejects.toThrow('forbidden')
  })

  /** If absent: two host-injected providers (multi-window, or test+prod) share module-level state and one window's projects leak into the other. */
  it('two host-supplied providers are independent values; one does not observe the other', async () => {
    const make = (seed: Project[]): ProjectsProvider => {
      const store = [...seed]
      return {
        listProjects: async () => [...store],
        addProject: async (p) => {
          const proj = { name: 'n', path: p, lastOpened: null }
          store.unshift(proj)
          return proj
        },
        removeProject: async (p) => {
          const i = store.findIndex((x) => x.path === p)
          if (i >= 0) store.splice(i, 1)
        },
      }
    }
    const a = make([{ name: 'a', path: '/p/a' }])
    const b = make([{ name: 'b', path: '/p/b' }])
    await a.addProject('/p/a2')
    expect((await a.listProjects()).map((p) => p.path)).toEqual(['/p/a2', '/p/a'])
    expect((await b.listProjects()).map((p) => p.path)).toEqual(['/p/b'])
  })

  /** If absent: a removeProject impl that accidentally returns a value (e.g. `return store.splice(...)`) leaks internal state across the IPC boundary. */
  it('removeProject: callers must treat resolution as opaque regardless of impl return', async () => {
    const provider: ProjectsProvider = {
      listProjects: () => [],
      addProject: (p) => ({ name: 'x', path: p }),
      removeProject: ((_p: string) => ['leaked', 'row']) as unknown as ProjectsProvider['removeProject'],
    }
    const spy = vi.fn()
    await Promise.resolve(provider.removeProject('/p/x')).then(spy)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
