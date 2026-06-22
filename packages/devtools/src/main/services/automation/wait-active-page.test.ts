/**
 * Contract tests for automation/wait-active-page.ts
 *
 * `waitForActivePage(bridge, opts)` replaces the blind `setTimeout(1500/2000)`
 * navigation waits in handlers/app.ts with "wait for the bridge's activePage
 * signal, with a timeout floor". Contract:
 *
 *   - Subscribe to bridge.onRenderEvent. On `kind:'activePage'` that matches
 *     (opts.match(bridgeId, pagePath) === true, else bridgeId !== opts.since)
 *     → resolve, unsubscribe, clear the timeout.
 *   - Timeout floor: at opts.timeoutMs with no match → resolve (NEVER reject,
 *     never hang), unsubscribe.
 *   - Race close: right after subscribing, read getActiveBridgeId() once; if
 *     (no match given) it is already !== since → resolve immediately.
 *   - Idempotent: resolve exactly once; later events must not throw and the
 *     unsubscribe must already have run.
 *
 * Covered cases:
 *   (a) matching activePage → resolve + unsubscribe called
 *   (b) since compare: bridgeId === since does NOT resolve; !== since resolves
 *   (c) match predicate: only resolves when it hits the target pagePath
 *   (d) timeout floor: advancing fake timer to timeoutMs resolves (no reject)
 *   (e) race close: getActiveBridgeId() already !== since → resolves w/o event
 *   (f) resolve-once: a second event after resolve doesn't throw; unsubscribe ran
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForActivePage } from './wait-active-page.js'

// ── render event shape mirrored from BridgeRouterHandle (kept local so the
//    test pins the contract, not the production type) ──────────────────────
interface RenderEvent {
  kind: 'domReady' | 'activePage'
  appId: string
  bridgeId: string
  pagePath?: string
}

type RenderListener = (event: RenderEvent) => void

/** Minimal bridge surface `waitForActivePage` is allowed to touch. */
interface WaitBridge {
  onRenderEvent(listener: RenderListener): () => void
  getActiveBridgeId(): string | null
}

/**
 * Controllable bridge double:
 *   - emit(ev): push a render event to the live subscriber
 *   - unsubscribe: spy returned from onRenderEvent
 *   - setActive(id): controls getActiveBridgeId()'s return
 */
function makeBridge(initialActive: string | null = null) {
  let listener: RenderListener | null = null
  let active = initialActive
  const unsubscribe = vi.fn(() => {
    listener = null
  })
  const onRenderEvent = vi.fn((l: RenderListener) => {
    listener = l
    return unsubscribe
  })
  const bridge: WaitBridge = {
    onRenderEvent,
    getActiveBridgeId: () => active,
  }
  return {
    bridge,
    unsubscribe,
    onRenderEvent,
    setActive(id: string | null) {
      active = id
    },
    emit(ev: RenderEvent) {
      listener?.(ev)
    },
    hasListener() {
      return listener !== null
    },
  }
}

function activePageEvent(bridgeId: string, pagePath?: string): RenderEvent {
  return { kind: 'activePage', appId: 'app1', bridgeId, pagePath }
}

/** Resolves to true once `p` settles within the current (fake) microtask flush. */
async function settled(p: Promise<void>): Promise<boolean> {
  let done = false
  void p.then(() => {
    done = true
  })
  await Promise.resolve()
  await Promise.resolve()
  return done
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('waitForActivePage', () => {
  // (a)
  it('收到匹配的 activePage（bridgeId !== since）→ resolve 且调用 unsubscribe', async () => {
    const b = makeBridge('old-bridge')
    const p = waitForActivePage(b.bridge, { since: 'old-bridge', timeoutMs: 2000 })

    expect(b.onRenderEvent).toHaveBeenCalledTimes(1)
    expect(await settled(p)).toBe(false)

    b.emit(activePageEvent('new-bridge', '/pages/next'))
    expect(await settled(p)).toBe(true)
    expect(b.unsubscribe).toHaveBeenCalledTimes(1)

    await expect(p).resolves.toBeUndefined()
  })

  // (b) — since 比对：等于 since 不 resolve，不等于才 resolve
  it('activePage.bridgeId === since 不 resolve；后续 !== since 的事件才 resolve', async () => {
    const b = makeBridge('same-bridge')
    const p = waitForActivePage(b.bridge, { since: 'same-bridge', timeoutMs: 2000 })

    // 同一个 bridgeId（页面未真正切换）→ 不算导航完成
    b.emit(activePageEvent('same-bridge', '/pages/home'))
    expect(await settled(p)).toBe(false)
    expect(b.unsubscribe).not.toHaveBeenCalled()

    // 切到新页面 → resolve
    b.emit(activePageEvent('other-bridge', '/pages/home'))
    expect(await settled(p)).toBe(true)
    expect(b.unsubscribe).toHaveBeenCalledTimes(1)
  })

  // (b') — domReady 不是 activePage，不应触发 resolve
  it('非 activePage 事件（domReady）不 resolve', async () => {
    const b = makeBridge('old')
    const p = waitForActivePage(b.bridge, { since: 'old', timeoutMs: 2000 })

    b.emit({ kind: 'domReady', appId: 'app1', bridgeId: 'new' })
    expect(await settled(p)).toBe(false)
    expect(b.unsubscribe).not.toHaveBeenCalled()
  })

  // (c) — match predicate：只有命中目标 pagePath 才 resolve
  it('提供 match：只有命中目标 pagePath 才 resolve（since 不再参与判定）', async () => {
    const b = makeBridge('old')
    const match = vi.fn((_bridgeId: string, pagePath?: string) => pagePath === '/pages/target')
    const p = waitForActivePage(b.bridge, { since: 'old', timeoutMs: 2000, match })

    // 即使 bridgeId !== since，pagePath 不命中也不 resolve
    b.emit(activePageEvent('new', '/pages/other'))
    expect(await settled(p)).toBe(false)
    expect(b.unsubscribe).not.toHaveBeenCalled()

    // 命中目标 pagePath → resolve
    b.emit(activePageEvent('new', '/pages/target'))
    expect(await settled(p)).toBe(true)
    expect(match).toHaveBeenCalledWith('new', '/pages/target')
    expect(b.unsubscribe).toHaveBeenCalledTimes(1)
  })

  // (d) — 超时兜底：推进到 timeoutMs 后 resolve（绝不 reject、绝不挂死）
  it('无匹配信号：推进 fake timer 到 timeoutMs → resolve（不 reject）', async () => {
    const b = makeBridge('old')
    const p = waitForActivePage(b.bridge, { since: 'old', timeoutMs: 2000 })

    // 未到点：还没 resolve
    await vi.advanceTimersByTimeAsync(1999)
    expect(await settled(p)).toBe(false)

    // 到点：resolve 且退订
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled(p)).toBe(true)
    expect(b.unsubscribe).toHaveBeenCalledTimes(1)
    await expect(p).resolves.toBeUndefined()
  })

  // (e) — 竞态闭合：订阅后立刻发现 getActiveBridgeId() 已 !== since → 立即 resolve
  it('订阅时 getActiveBridgeId() 已 !== since → 不等事件立即 resolve', async () => {
    // 导航极快，订阅前 active 已经变成新 bridge
    const b = makeBridge('new-bridge')
    const p = waitForActivePage(b.bridge, { since: 'old-bridge', timeoutMs: 2000 })

    // 没有 emit 任何事件，仅凭初始快照即可 resolve
    expect(await settled(p)).toBe(true)
    expect(b.unsubscribe).toHaveBeenCalledTimes(1)
  })

  // (e') — 竞态闭合：当前 active 仍 === since → 不立即 resolve，继续等事件/超时
  it('订阅时 getActiveBridgeId() 仍 === since → 不立即 resolve，等到事件再 resolve', async () => {
    const b = makeBridge('old-bridge')
    const p = waitForActivePage(b.bridge, { since: 'old-bridge', timeoutMs: 2000 })

    expect(await settled(p)).toBe(false)
    expect(b.unsubscribe).not.toHaveBeenCalled()

    b.emit(activePageEvent('new-bridge'))
    expect(await settled(p)).toBe(true)
  })

  // (f) — 幂等：resolve 后再来事件不报错，且 unsubscribe 只调用一次
  it('resolve 后重复事件不再触发、不报错，unsubscribe 仅一次', async () => {
    const b = makeBridge('old')
    const p = waitForActivePage(b.bridge, { since: 'old', timeoutMs: 2000 })

    b.emit(activePageEvent('new', '/pages/a'))
    expect(await settled(p)).toBe(true)
    expect(b.unsubscribe).toHaveBeenCalledTimes(1)

    // 退订生效后不应还有活跃监听者；再推一个事件不得抛错、不得重复处理
    expect(b.hasListener()).toBe(false)
    expect(() => b.emit(activePageEvent('newer', '/pages/b'))).not.toThrow()

    // 超时定时器已被清掉：推进时间也不应产生第二次退订
    await vi.advanceTimersByTimeAsync(5000)
    expect(b.unsubscribe).toHaveBeenCalledTimes(1)
  })

  // onTimeout 回调（超时可见性扩展）
  it('超时兜底时 onTimeout 触发一次', async () => {
    const b = makeBridge('old')
    const onTimeout = vi.fn()
    const p = waitForActivePage(b.bridge, { since: 'old', timeoutMs: 2000, onTimeout })

    await vi.advanceTimersByTimeAsync(1999)
    expect(onTimeout).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(await settled(p)).toBe(true)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('信号匹配 resolve 时 onTimeout 不触发（且后续超时也不补触发）', async () => {
    const b = makeBridge('old')
    const onTimeout = vi.fn()
    const p = waitForActivePage(b.bridge, { since: 'old', timeoutMs: 2000, onTimeout })

    b.emit(activePageEvent('new', '/pages/x'))
    expect(await settled(p)).toBe(true)
    expect(onTimeout).not.toHaveBeenCalled()

    // 定时器已清，推进时间不应迟发 onTimeout
    await vi.advanceTimersByTimeAsync(5000)
    expect(onTimeout).not.toHaveBeenCalled()
  })
})
