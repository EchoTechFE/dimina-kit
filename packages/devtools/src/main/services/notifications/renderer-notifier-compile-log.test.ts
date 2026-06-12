/**
 * ROUND 2 (dmcc 日志链路) — RendererNotifier `compileLog` contract
 * (TDD, NOT yet implemented).
 *
 * Pinned contract:
 *  - `ProjectChannel` gains `CompileLog: 'project:compileLog'` — a NEW push
 *    channel. The existing `project:status` channel is NOT reused: the
 *    wave-1 TDD suite pins `compileEvents` as "one entry per projectStatus
 *    payload", so pushing per-line logs there would pollute that contract
 *    (and every other projectStatus consumer: use-session / use-simulator).
 *  - `RendererNotifier` gains
 *    `compileLog(payload: { at: number; stream: 'stdout' | 'stderr'; text: string }): void`
 *    routed to the main window like `projectStatus` — same destroyed-target
 *    no-op guarantees.
 *
 * Note on schemas: `shared/ipc-schemas.ts` only validates renderer→main
 * `ipcMain.handle` arguments; main→renderer pushes (Status, CompileLog) are
 * typed via payload interfaces instead — no schema entry is added.
 *
 * Structural lookups keep this file typechecking while the channel/method do
 * not exist yet — the runtime assertions are the red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProjectChannel } from '../../../shared/ipc-channels.js'
import { createRendererNotifier } from './renderer-notifier.js'

interface CompileLogPayload {
  at: number
  stream: 'stdout' | 'stderr'
  text: string
}

type CompileLogMethod = (payload: CompileLogPayload) => void

function makeWebContents() {
  return {
    destroyed: false,
    send: vi.fn(),
    isDestroyed() { return this.destroyed },
  }
}

function makeBrowserWindow() {
  const wc = makeWebContents()
  return {
    destroyed: false,
    webContents: wc,
    isDestroyed() { return this.destroyed },
  }
}

function makeNotifier() {
  const mainWindow = makeBrowserWindow()
  const ctx = {
    windows: { mainWindow: mainWindow as unknown as Electron.BrowserWindow },
    views: { getSettingsWebContents: () => null },
  }
  return { mainWindow, notifier: createRendererNotifier(ctx) }
}

function getCompileLog(notifier: unknown): CompileLogMethod {
  const method = (notifier as { compileLog?: unknown }).compileLog
  expect(
    typeof method,
    'RendererNotifier must expose compileLog(payload) — the per-line compile-log push next to projectStatus',
  ).toBe('function')
  return method as CompileLogMethod
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ProjectChannel.CompileLog wire name', () => {
  it("is 'project:compileLog' (a NEW channel — project:status keeps its one-event-per-payload contract)", () => {
    const channel = (ProjectChannel as Record<string, string>).CompileLog
    expect(
      channel,
      'ProjectChannel must gain CompileLog — a dedicated push channel for per-line compile logs',
    ).toBe('project:compileLog')
  })
})

describe('RendererNotifier.compileLog', () => {
  it('sends the payload verbatim to the main window on ProjectChannel.CompileLog', () => {
    const { mainWindow, notifier } = makeNotifier()
    const compileLog = getCompileLog(notifier)

    const payload: CompileLogPayload = {
      at: 1765500000000,
      stream: 'stderr',
      text: '[logic] esbuild 转换失败 /tmp/proj/pages/index/index.js: Transform failed with 1 error:',
    }
    compileLog(payload)

    expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      (ProjectChannel as Record<string, string>).CompileLog,
      payload,
    )
  })

  it('forwards every line 1:1 in order (no batching / dedup at the notifier layer)', () => {
    const { mainWindow, notifier } = makeNotifier()
    const compileLog = getCompileLog(notifier)

    compileLog({ at: 1, stream: 'stdout', text: '✔ 收集配置信息' })
    compileLog({ at: 2, stream: 'stdout', text: '✔ 输出编译产物' })
    compileLog({ at: 3, stream: 'stderr', text: '✖ 编译页面逻辑 [FAILED: …]' })

    expect(mainWindow.webContents.send).toHaveBeenCalledTimes(3)
    expect(mainWindow.webContents.send.mock.calls.map((c) => (c[1] as CompileLogPayload).text)).toEqual([
      '✔ 收集配置信息',
      '✔ 输出编译产物',
      '✖ 编译页面逻辑 [FAILED: …]',
    ])
  })

  it('no-ops (and never throws) once the main window is destroyed', () => {
    const { mainWindow, notifier } = makeNotifier()
    const compileLog = getCompileLog(notifier)

    compileLog({ at: 1, stream: 'stdout', text: '✔ x' })
    expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)

    mainWindow.destroyed = true
    expect(() => compileLog({ at: 2, stream: 'stdout', text: '✔ y' })).not.toThrow()
    expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
  })

  it('no-ops once only the webContents is destroyed (window still alive)', () => {
    const { mainWindow, notifier } = makeNotifier()
    const compileLog = getCompileLog(notifier)

    mainWindow.webContents.destroyed = true
    expect(() => compileLog({ at: 1, stream: 'stderr', text: '✖ x' })).not.toThrow()
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
  })
})
