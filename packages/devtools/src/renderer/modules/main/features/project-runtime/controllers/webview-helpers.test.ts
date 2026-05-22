import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { forceFullNavigate } from './webview-helpers'
import type { WebviewLike } from './webview-helpers'

function makeWebview(currentUrl: string): WebviewLike {
  return {
    getURL: vi.fn(() => currentUrl),
    reload: vi.fn(),
    loadURL: vi.fn(),
  } as unknown as WebviewLike
}

describe('forceFullNavigate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('当前 URL 与目标相同时：只调 reload 一次，不调 loadURL', () => {
    const url = 'http://localhost:3000/#/page-a'
    const webview = makeWebview(url)

    forceFullNavigate(webview, url)

    expect(webview.reload).toHaveBeenCalledTimes(1)
    expect(webview.loadURL).not.toHaveBeenCalled()
  })

  it('当前 URL 与目标不同时：立即调 loadURL；100ms 前 reload 未调用；100ms 后 reload 调用一次', () => {
    const current = 'http://localhost:3000/#/page-a'
    const target = 'http://localhost:3000/#/page-b'
    const webview = makeWebview(current)

    forceFullNavigate(webview, target)

    // loadURL 应立即被调用
    expect(webview.loadURL).toHaveBeenCalledTimes(1)
    expect(webview.loadURL).toHaveBeenCalledWith(target)

    // 100ms 前 reload 不应调用
    vi.advanceTimersByTime(99)
    expect(webview.reload).not.toHaveBeenCalled()

    // 到达 100ms 后 reload 应调用一次
    vi.advanceTimersByTime(1)
    expect(webview.reload).toHaveBeenCalledTimes(1)
  })

  it('getURL 返回空字符串时，目标非空 → 走 loadURL 分支', () => {
    const webview = makeWebview('')
    const target = 'http://localhost:3000/#/page-a'

    forceFullNavigate(webview, target)

    expect(webview.loadURL).toHaveBeenCalledWith(target)
    expect(webview.reload).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)
    expect(webview.reload).toHaveBeenCalledTimes(1)
  })
})
