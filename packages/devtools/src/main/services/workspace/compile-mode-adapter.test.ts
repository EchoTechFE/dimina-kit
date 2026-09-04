/**
 * Contract: `createCompileModeAdapter` must degrade symmetrically in both
 * directions when a `ProjectsProvider` implements only the older single-config
 * pair (`getCompileConfig` / `saveCompileConfig`) and omits the newer mode-list
 * pair (`getCompileModes` / `saveCompileModes`).
 *
 * `saveCompileModes` already degrades this way (falls back to
 * `provider.saveCompileConfig`). `getCompileModes` did not: it returned
 * `emptyCompileModes()` outright without ever looking at `getCompileConfig`,
 * so a host on the old interface has its launch config silently discarded —
 * the dropdown shows 普通编译 while the host's real entry page and query
 * params go unused.
 */
import { describe, it, expect } from 'vitest'
import { createCompileModeAdapter } from './compile-mode-adapter.js'
import { resolveCompileConfig } from '../../../shared/compile-modes.js'
import { DEFAULT_SCENE } from '../../../shared/constants.js'
import type { CompileConfig } from '../../../shared/types.js'
import type { ProjectsProvider } from '../projects/types.js'

function makeLegacyOnlyProvider(config: CompileConfig): ProjectsProvider {
  return {
    listProjects: () => [],
    addProject: (p: string) => ({ name: p, path: p, lastOpened: null }),
    removeProject: () => {},
    getCompileConfig: () => config,
    saveCompileConfig: () => {},
    // getCompileModes / saveCompileModes intentionally omitted.
  }
}

describe('createCompileModeAdapter — getCompileModes falls back to getCompileConfig', () => {
  it('宿主只有旧的 getCompileConfig 且值不等价于普通编译时，模式列表要能表达它并选中它', async () => {
    const hostConfig: CompileConfig = {
      startPage: 'pages/debug/index',
      scene: 1011,
      queryParams: [{ key: 'from', value: 'host' }],
    }
    const adapter = createCompileModeAdapter(makeLegacyOnlyProvider(hostConfig))

    const modes = await adapter.getCompileModes('/p/x')

    expect(modes.current).toBeGreaterThanOrEqual(0)
    const selected = modes.list[modes.current]
    expect(selected).toBeDefined()
    expect(selected.pathName).toBe('pages/debug/index')
    expect(selected.scene).toBe(1011)
    expect(resolveCompileConfig(modes).queryParams).toEqual([{ key: 'from', value: 'host' }])

    // Round-trips back to exactly what the host's own getCompileConfig returns.
    expect(resolveCompileConfig(modes)).toEqual(await adapter.getCompileConfig('/p/x'))
  })

  it('宿主的旧配置就是普通编译等价物时，不凭空造出一条模式', async () => {
    const hostConfig: CompileConfig = { startPage: '', scene: DEFAULT_SCENE, queryParams: [] }
    const adapter = createCompileModeAdapter(makeLegacyOnlyProvider(hostConfig))

    expect(await adapter.getCompileModes('/p/x')).toEqual({ current: -1, list: [] })
  })
})
