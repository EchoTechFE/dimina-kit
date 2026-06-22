/**
 * Tests for automation/handlers/app.ts
 *
 * 聚焦：App.callWxMethod navigateTo 分支里 cleanUrl 插入选择器的注入面。
 *
 * 当前实现：
 *   `_doc.querySelector('[data-path="${cleanUrl}"]')`
 * cleanUrl 未经任何转义直接插入双引号包围的属性选择器，
 * 若路径含 `"` 或 `]` 会破坏选择器语法（注入面）。
 *
 * 重构后契约：按 data-path 精确匹配时必须注入安全。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchContext } from '../../workbench-context.js'

// ── electron stub（hoisted，和 index.test.ts 模式一致）─────────────────
const electronStub = vi.hoisted(() => ({
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  app: { on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: class {},
}))

vi.mock('electron', () => electronStub)

// ── exec.js stub：记录 evalInSim 的调用 ───────────────────────────────
const execStub = vi.hoisted(() => {
  const evalInSimMock = vi.fn()
  const getSimulatorMock = vi.fn()
  return { evalInSimMock, getSimulatorMock }
})

vi.mock('../exec.js', () => ({
  evalInSim: execStub.evalInSimMock,
  getSimulator: execStub.getSimulatorMock,
  inIframe: (code: string) =>
    `(()=>{ const iframes=document.querySelectorAll('iframe'); const iframe=iframes[iframes.length-1]; if(!iframe||!iframe.contentDocument)throw new Error('No page iframe'); const _doc=iframe.contentDocument; return (function(){${code}})() })()`,
}))

// simulator-route stub（readRoute 用到）
vi.mock('../../../../shared/simulator-route.js', () => ({
  parseLocationRoute: vi.fn(() => null),
}))

// ── import handler AFTER mocks ────────────────────────────────────────
import { appHandlers } from './app.js'

// ── fake ctx ────────────────────────────────────────────────────────────
function makeCtx(): WorkbenchContext {
  return {
    views: { getSimulatorWebContentsId: () => 1 },
    workspace: { hasActiveSession: () => true, closeProject: vi.fn() },
  } as unknown as WorkbenchContext
}

beforeEach(() => {
  vi.useFakeTimers()
  execStub.evalInSimMock.mockReset()
  execStub.getSimulatorMock.mockReset()
  // 默认让 evalInSim 返回 false（模拟 click 失败，进 fallback 分支）
  execStub.evalInSimMock.mockResolvedValue(false)
})

afterEach(() => {
  vi.useRealTimers()
})

// ── helper：并发 handler 调用与时间推进，避免真等 2000ms ────────────────
async function callNavigate(url: string) {
  const promise = appHandlers['App.callWxMethod']!(makeCtx(), {
    method: 'navigateTo',
    args: [{ url }],
  })
  // 推进 2000ms 计时器（setTimeout(r, 2000) in the handler）
  await vi.advanceTimersByTimeAsync(2100)
  return promise
}

// ── tests ────────────────────────────────────────────────────────────────

describe('App.callWxMethod navigateTo — cleanUrl 注入安全性', () => {
  it('正常路径：evalInSim 第一次被调用时脚本里含 data-path 查询逻辑', async () => {
    await callNavigate('/pages/index')
    expect(execStub.evalInSimMock).toHaveBeenCalled()
    const firstScript: string = execStub.evalInSimMock.mock.calls[0]![1] as string
    // 应该有某种 data-path 匹配逻辑
    expect(firstScript).toContain('data-path')
  })

  it('路径含双引号：不能将裸双引号插入选择器字符串（当前实现 red）', async () => {
    // url = /pages/x?a="b
    // 当前实现产出: [data-path="/pages/x?a="b"]  ← 选择器在 " 处就截断，后续 b"] 成为垃圾
    const badUrl = '/pages/x?a="b'
    await callNavigate(badUrl)

    const firstScript: string = execStub.evalInSimMock.mock.calls[0]![1] as string

    // 断言：脚本里不应包含可破坏选择器的裸插值片段
    // 裸插值形式: data-path="${cleanUrl}" → 即 data-path="/pages/x?a="b"
    // 识别手法：脚本里出现 data-path=" 之后紧跟原始 url 的裸形式（含未转义 "）
    // 如果脚本里存在 `data-path="/pages/x?a="b"` 这种破坏性串，测试 red
    const dangerousFragment = `data-path="${badUrl}"`
    expect(firstScript).not.toContain(dangerousFragment)

    // 同时断言：路径值以某种安全形式出现（JSON 序列化、属性值比对等）
    // 检测方法：JSON.stringify 会把 " 转义为 \"，所以安全实现里应包含转义后的形式
    // 或者实现改用遍历比对，则不会出现 data-path=... 的属性选择器形式
    // 宽松断言：脚本里不存在以裸 " 结尾并紧跟 ] 的 data-path 属性选择器
    expect(firstScript).not.toMatch(/data-path="[^"]*"[^"]*"/)
  })

  it('路径含右方括号：不能将裸 ] 插入选择器字符串（当前实现 red）', async () => {
    // url = /pages/x"]
    // 当前实现: querySelector('[data-path="/pages/x"]"]') ← ] 提前闭合
    const badUrl = '/pages/x"]'
    await callNavigate(badUrl)

    const firstScript: string = execStub.evalInSimMock.mock.calls[0]![1] as string

    // 裸插值产出：[data-path="/pages/x"]"] —— 其中 /pages/x"] 的第一个 ] 会提前关闭选择器
    // 识别：若脚本里含 data-path 的属性选择器，其中存在 ] 在引号之前关闭
    // 简单断言：脚本里不应含原始未转义的 badUrl 作为选择器属性值
    // 即不应出现形如 '[data-path="/pages/x"]"]' 的片段
    const dangerousFragment = `data-path="${badUrl}"`
    expect(firstScript).not.toContain(dangerousFragment)
  })

  it('路径含单引号：以 JSON 字面量形式嵌入脚本（注入安全）', async () => {
    const badUrl = "/pages/x'y"
    await callNavigate(badUrl)

    const firstScript: string = execStub.evalInSimMock.mock.calls[0]![1] as string

    // 路径必须以 JSON 字面量形式出现在生成脚本里，而不是裸插进属性选择器。
    expect(firstScript).toContain(JSON.stringify(badUrl))
  })

  it('对含特殊字符的路径：evalInSim 仍被调用（handler 没有 crash）', async () => {
    // 即使 url 有特殊字符，handler 本身不应抛出，只是 evalInSim 收到不同脚本
    const urls = ['/p?a=1&b=2', '/p#hash', '/p%20q']
    for (const url of urls) {
      execStub.evalInSimMock.mockReset()
      execStub.evalInSimMock.mockResolvedValue(false)
      await callNavigate(url)
      expect(execStub.evalInSimMock).toHaveBeenCalled()
    }
  })
})

describe('App.callWxMethod navigateTo — 不等待真实 2000ms', () => {
  it('使用 fakeTimers 推进计时器，Promise 正常 resolve', async () => {
    // 测试本身不应花 2 秒；若 fakeTimers 不生效则 promise 不会 resolve
    const p = appHandlers['App.callWxMethod']!(makeCtx(), {
      method: 'navigateTo',
      args: [{ url: '/pages/index' }],
    })
    // handler 里有 await new Promise(r => setTimeout(r, 2000))
    await vi.advanceTimersByTimeAsync(2100)
    const result = await p
    expect(result).toEqual({ result: undefined })
  })
})
