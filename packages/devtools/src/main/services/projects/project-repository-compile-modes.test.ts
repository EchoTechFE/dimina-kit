/**
 * Contract: the compile-mode storage layer in `project-repository.ts` —
 * `getCompileModes` / `saveCompileModes` / `getCompileConfig` /
 * `saveCompileConfig`.
 *
 * Bugs each group catches:
 *  - `getCompileModes`: reading the wrong file, or reading public over
 *    private (WeChat DevTools' own precedence is private-wins), makes a
 *    project show different modes on this machine than it does elsewhere.
 *  - Legacy migration: a project imported before compile modes existed must
 *    keep its old single start page. Migrating unconditionally (even for a
 *    config that is exactly 普通编译) would clutter every legacy project
 *    with a spurious mode; migrating and then persisting would silently
 *    rewrite the user's project.config.json on a mere read.
 *  - `saveCompileModes`: this file also holds unrelated project settings
 *    (appid, other `condition` blocks). A naive `JSON.stringify(modes)`
 *    write would drop them. A JSON-parse failure must not be "fixed" by
 *    clobbering the file — that would destroy whatever the user had.
 *  - `getCompileConfig`: 普通编译 has no stored start page; forgetting to
 *    fill it from the project's real entry page blank-screens the simulator.
 *  - `saveCompileConfig` (deprecated but still called by embedding hosts):
 *    must route into the mode list instead of silently doing nothing, and
 *    must not rename the mode it overwrites.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { DEFAULT_SCENE } from '../../../shared/constants.js'
import type { CompileModes } from '../../../shared/types.js'

let userDataDir = ''

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => userDataDir) },
  default: { app: { getPath: () => userDataDir } },
}))

let getCompileModes: typeof import('./project-repository.js').getCompileModes
let saveCompileModes: typeof import('./project-repository.js').saveCompileModes
let getCompileConfig: typeof import('./project-repository.js').getCompileConfig
let saveCompileConfig: typeof import('./project-repository.js').saveCompileConfig

const createdDirs: string[] = []

/** Fresh project directory, cleaned up in `afterEach`. */
function makeProjectDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-compile-modes-'))
  createdDirs.push(dir)
  return dir
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2))
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>
}

function writeAppJson(dir: string, entryPagePath = 'pages/index/index'): void {
  writeJson(path.join(dir, 'app.json'), { pages: [entryPagePath], entryPagePath })
}

/** Seeds the project list file `getProjectsFile()` resolves to (real fs, real userData dir). */
function writeProjectsList(entries: unknown[]): void {
  writeJson(path.join(userDataDir, 'dimina-projects.json'), entries)
}

beforeEach(async () => {
  vi.resetModules()
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-compile-modes-userdata-'))
  createdDirs.push(userDataDir)
  ;({ getCompileModes, saveCompileModes, getCompileConfig, saveCompileConfig } =
    await import('./project-repository.js'))
})

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('getCompileModes — 读取与私有配置优先级', () => {
  it('dirPath 为空串时返回空模型，不读取任何文件', () => {
    expect(getCompileModes('')).toEqual({ current: -1, list: [] })
  })

  it('condition.miniprogram 缺失且没有旧记录时返回空模型', () => {
    const dir = makeProjectDir()
    writeAppJson(dir)
    expect(getCompileModes(dir)).toEqual({ current: -1, list: [] })
  })

  it('从 project.config.json 的 condition.miniprogram 读取并归一化', () => {
    const dir = makeProjectDir()
    writeAppJson(dir)
    writeJson(path.join(dir, 'project.config.json'), {
      appid: 'wx-test',
      condition: {
        miniprogram: {
          current: 0,
          list: [{ name: '自定义模式', pathName: 'pages/a/a', query: 'x=1', scene: 1011 }],
        },
      },
    })

    expect(getCompileModes(dir)).toEqual({
      current: 0,
      list: [{ name: '自定义模式', pathName: 'pages/a/a', query: 'x=1', scene: 1011 }],
    })
  })

  it('project.private.config.json 的 condition 整体覆盖 public 的 condition（private 优先）', () => {
    const dir = makeProjectDir()
    writeAppJson(dir)
    writeJson(path.join(dir, 'project.config.json'), {
      condition: {
        miniprogram: { current: 0, list: [{ name: '公共', pathName: 'pages/pub/pub', query: '', scene: null }] },
      },
    })
    writeJson(path.join(dir, 'project.private.config.json'), {
      condition: {
        miniprogram: { current: -1, list: [] },
      },
    })

    expect(getCompileModes(dir)).toEqual({ current: -1, list: [] })
  })
})

describe('getCompileModes — 迁移旧版单一 compileConfig（只读）', () => {
  it('旧 compileConfig 等价于普通编译时迁移为空列表，且不写回文件', () => {
    const dir = makeProjectDir()
    writeAppJson(dir, 'pages/index/index')
    writeProjectsList([
      {
        name: 'legacy',
        path: dir,
        compileConfig: { startPage: 'pages/index/index', scene: DEFAULT_SCENE, queryParams: [] },
      },
    ])

    expect(getCompileModes(dir)).toEqual({ current: -1, list: [] })
    expect(fs.existsSync(path.join(dir, 'project.config.json'))).toBe(false)
  })

  it('旧 compileConfig 不等价于普通编译时迁移为单条已选中的模式，且不写回文件', () => {
    const dir = makeProjectDir()
    writeAppJson(dir, 'pages/index/index')
    writeProjectsList([
      {
        name: 'legacy',
        path: dir,
        compileConfig: {
          startPage: 'pages/other/other',
          scene: 1011,
          queryParams: [{ key: 'k', value: 'v' }],
        },
      },
    ])

    expect(getCompileModes(dir)).toEqual({
      current: 0,
      list: [{ name: '', pathName: 'pages/other/other', query: 'k=v', scene: 1011 }],
    })
    expect(fs.existsSync(path.join(dir, 'project.config.json'))).toBe(false)
  })
})

describe('saveCompileModes — 合并写入 project.config.json', () => {
  it('dirPath 为空串时直接返回，不抛错', () => {
    expect(() => saveCompileModes('', { current: -1, list: [] })).not.toThrow()
  })

  it('文件不存在时新建，只包含 condition.miniprogram', () => {
    const dir = makeProjectDir()
    const modes: CompileModes = {
      current: 0,
      list: [{ name: 'm', pathName: 'pages/a/a', query: '', scene: null }],
    }

    saveCompileModes(dir, modes)

    const written = readJson(path.join(dir, 'project.config.json'))
    expect(written.condition).toEqual({ miniprogram: modes })
  })

  it('保留同一文件里的其它顶层字段和 condition 下的其它键（如 condition.game）', () => {
    const dir = makeProjectDir()
    writeJson(path.join(dir, 'project.config.json'), {
      appid: 'wx-keep-me',
      projectname: 'keep-me-too',
      condition: {
        game: { current: -1, list: [{ name: 'g', pathName: 'game.js', query: '', scene: null }] },
        miniprogram: { current: -1, list: [] },
      },
    })
    const modes: CompileModes = {
      current: 0,
      list: [{ name: 'new-mode', pathName: 'pages/b/b', query: 'q=1', scene: 1001 }],
    }

    saveCompileModes(dir, modes)

    const written = readJson(path.join(dir, 'project.config.json'))
    expect(written.appid).toBe('wx-keep-me')
    expect(written.projectname).toBe('keep-me-too')
    expect((written.condition as Record<string, unknown>).game).toEqual({
      current: -1,
      list: [{ name: 'g', pathName: 'game.js', query: '', scene: null }],
    })
    expect((written.condition as Record<string, unknown>).miniprogram).toEqual(modes)
  })

  it('文件存在但不是合法 JSON 时抛错，且原文件内容不被覆盖', () => {
    const dir = makeProjectDir()
    const configPath = path.join(dir, 'project.config.json')
    const originalRaw = '{ not valid json at all'
    fs.writeFileSync(configPath, originalRaw)

    expect(() => saveCompileModes(dir, { current: -1, list: [] })).toThrow(/无法保存编译模式/)
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(originalRaw)
  })
})

describe('saveCompileModes — 与 project.private.config.json 共存时必须能读回', () => {
  /**
   * Bug: `saveCompileModes` only ever writes `project.config.json`.
   * `readProjectConfig` merges private over public at the top level, so any
   * `condition` key in the private file — even one that only holds a
   * mini-game block, with no `miniprogram` key at all — replaces the whole
   * merged `condition` and hides what was just saved. The save reports
   * success but the next read silently loses it.
   */
  it('private 文件的 condition 只有 condition.game（没有 miniprogram）时，保存的模式仍要能读回', () => {
    const dir = makeProjectDir()
    writeAppJson(dir)
    writeJson(path.join(dir, 'project.private.config.json'), {
      projectname: 'keep-me',
      condition: {
        game: { current: -1, list: [{ name: 'g', pathName: 'game.js', query: '', scene: null }] },
      },
    })
    const modes: CompileModes = {
      current: 0,
      list: [{ name: '新模式', pathName: 'pages/new/new', query: 'a=1', scene: 1011 }],
    }

    saveCompileModes(dir, modes)

    expect(getCompileModes(dir)).toEqual(modes)
    const privateConfig = readJson(path.join(dir, 'project.private.config.json'))
    expect(privateConfig.projectname).toBe('keep-me')
    expect((privateConfig.condition as Record<string, unknown>).game).toEqual({
      current: -1,
      list: [{ name: 'g', pathName: 'game.js', query: '', scene: null }],
    })
  })

  /**
   * Same bug, more direct: the private file already carries an old
   * `condition.miniprogram` list. Saving a new list must make it the one
   * `getCompileModes` returns — private-wins on read must not mean the
   * public write can never take effect again.
   */
  it('private 文件里已有旧的 condition.miniprogram 时，保存新模式后读回的必须是新模式', () => {
    const dir = makeProjectDir()
    writeAppJson(dir)
    writeJson(path.join(dir, 'project.private.config.json'), {
      condition: {
        miniprogram: {
          current: 0,
          list: [{ name: '旧模式', pathName: 'pages/old/old', query: '', scene: 1001 }],
        },
      },
    })
    const modes: CompileModes = {
      current: 0,
      list: [{ name: '新模式', pathName: 'pages/new/new', query: 'a=1', scene: 1011 }],
    }

    saveCompileModes(dir, modes)

    expect(getCompileModes(dir)).toEqual(modes)
  })
})

describe('getCompileConfig — 普通编译回填项目自己的 entryPagePath', () => {
  it('普通编译（无自定义模式）时 startPage 取自项目的 entryPagePath', () => {
    const dir = makeProjectDir()
    writeAppJson(dir, 'pages/home/home')

    expect(getCompileConfig(dir)).toEqual({
      startPage: 'pages/home/home',
      scene: DEFAULT_SCENE,
      queryParams: [],
    })
  })

  it('已选中的模式自带 startPage 时不会被项目的 entryPagePath 覆盖', () => {
    const dir = makeProjectDir()
    writeAppJson(dir, 'pages/home/home')
    writeJson(path.join(dir, 'project.config.json'), {
      condition: {
        miniprogram: {
          current: 0,
          list: [{ name: 'm', pathName: 'pages/other/other', query: '', scene: 1011 }],
        },
      },
    })

    expect(getCompileConfig(dir)).toEqual({
      startPage: 'pages/other/other',
      scene: 1011,
      queryParams: [],
    })
  })
})

describe('saveCompileConfig（deprecated）— 单配置写入路由到模式列表', () => {
  it('当前选中普通编译，新 config 不等价于普通编译时，追加为新模式并选中它', () => {
    const dir = makeProjectDir()
    writeAppJson(dir, 'pages/index/index')

    saveCompileConfig(dir, {
      startPage: 'pages/other/other',
      scene: 1011,
      queryParams: [{ key: 'k', value: 'v' }],
    })

    expect(getCompileModes(dir)).toEqual({
      current: 0,
      list: [{ name: '', pathName: 'pages/other/other', query: 'k=v', scene: 1011 }],
    })
  })

  it('当前选中普通编译，新 config 等价于普通编译时不写入任何文件（no-op）', () => {
    const dir = makeProjectDir()
    writeAppJson(dir, 'pages/index/index')

    saveCompileConfig(dir, { startPage: 'pages/index/index', scene: DEFAULT_SCENE, queryParams: [] })

    expect(fs.existsSync(path.join(dir, 'project.config.json'))).toBe(false)
  })

  it('当前选中某个模式时就地覆盖该模式，且保留它的 name', () => {
    const dir = makeProjectDir()
    writeAppJson(dir, 'pages/index/index')
    writeJson(path.join(dir, 'project.config.json'), {
      condition: {
        miniprogram: {
          current: 0,
          list: [{ name: '我的模式', pathName: 'pages/a/a', query: '', scene: 1001 }],
        },
      },
    })

    saveCompileConfig(dir, {
      startPage: 'pages/b/b',
      scene: 1002,
      queryParams: [{ key: 'x', value: '1' }],
    })

    expect(getCompileModes(dir)).toEqual({
      current: 0,
      list: [{ name: '我的模式', pathName: 'pages/b/b', query: 'x=1', scene: 1002 }],
    })
  })
})
