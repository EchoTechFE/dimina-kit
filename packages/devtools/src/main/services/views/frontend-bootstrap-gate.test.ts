/**
 * Guards `frontend-bootstrap-gate.ts` — the single choke point every
 * front-end injector must go through before firing a `.instance()`-style
 * script at the DevTools front-end. Injecting before the front-end's own
 * bootstrap finishes permanently freezes it (IssuesManager `ensureFirst`
 * conflict triggered by an early `Console.ConsoleView.instance()` or
 * similar singleton construction).
 *
 * Two exports under test:
 * - `FRONTEND_BOOTSTRAP_PROBE_SCRIPT`: a side-effect-free in-realm probe
 *   string, safe to feed directly to `wc.executeJavaScript`.
 * - `whenFrontendBootstrapped`: polls that probe against a live
 *   `WebContents` until it reports ready, times out, or the wc is
 *   destroyed — and must never reject or leak a live timer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FRONTEND_BOOTSTRAP_PROBE_SCRIPT, whenFrontendBootstrapped } from './frontend-bootstrap-gate.js'
import type { WebContents } from 'electron'

/** Minimal WebContents stand-in: only the two members the gate consults. */
function createMockWc(destroyed = false) {
  let isDestroyedFlag = destroyed
  const executeJavaScript = vi.fn()
  return {
    executeJavaScript,
    isDestroyed: () => isDestroyedFlag,
    setDestroyed(v: boolean) { isDestroyedFlag = v },
  }
}

const asWc = (wc: ReturnType<typeof createMockWc>): WebContents => wc as unknown as WebContents

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete (globalThis as Record<string, unknown>).EUI
})

describe('FRONTEND_BOOTSTRAP_PROBE_SCRIPT', () => {
  it('probes readiness through EUI.ShortcutRegistry.ShortcutRegistry.instance()', () => {
    expect(FRONTEND_BOOTSTRAP_PROBE_SCRIPT).toMatch(/ShortcutRegistry\.ShortcutRegistry\.instance\(\)/)
  })

  it('never calls ConsoleView.instance() — the exact singleton construction this gate exists to prevent', () => {
    expect(FRONTEND_BOOTSTRAP_PROBE_SCRIPT).not.toMatch(/ConsoleView\.instance\(\)/)
  })

  it('never calls ViewManager.instance()', () => {
    expect(FRONTEND_BOOTSTRAP_PROBE_SCRIPT).not.toMatch(/ViewManager\.instance\(\)/)
  })

  it('never calls IssuesManager.instance()', () => {
    expect(FRONTEND_BOOTSTRAP_PROBE_SCRIPT).not.toMatch(/IssuesManager\.instance\(\)/)
  })

  // The probe is an EXPRESSION (executeJavaScript resolves an expression's
  // completion value; a top-level `return` there is a SyntaxError), so the
  // in-test runner evaluates it the same way: as a returned expression.
  const runProbe = (): unknown => new Function(`return ${FRONTEND_BOOTSTRAP_PROBE_SCRIPT}`)()

  it('reports false, not a thrown error, when EUI does not exist in the realm yet', () => {
    expect(runProbe()).toBe(false)
  })

  it('reports true once ShortcutRegistry.instance() can construct without throwing', () => {
    ;(globalThis as Record<string, unknown>).EUI = { ShortcutRegistry: { ShortcutRegistry: { instance: () => ({}) } } }
    expect(runProbe()).toBe(true)
  })

  it('reports false, and does not propagate the throw, while ShortcutRegistry.instance() still throws', () => {
    ;(globalThis as Record<string, unknown>).EUI = {
      ShortcutRegistry: { ShortcutRegistry: { instance: () => { throw new Error('not ready') } } },
    }
    let result: unknown
    expect(() => { result = runProbe() }).not.toThrow()
    expect(result).toBe(false)
  })
})

describe('whenFrontendBootstrapped', () => {
  it('resolves true from the very first probe call, without waiting for a poll interval', async () => {
    const wc = createMockWc()
    wc.executeJavaScript.mockResolvedValue(true)

    await expect(whenFrontendBootstrapped(asWc(wc))).resolves.toBe(true)
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(1)
  })

  it('feeds FRONTEND_BOOTSTRAP_PROBE_SCRIPT itself into executeJavaScript', async () => {
    const wc = createMockWc()
    wc.executeJavaScript.mockResolvedValue(true)

    await whenFrontendBootstrapped(asWc(wc))
    expect(wc.executeJavaScript).toHaveBeenCalledWith(FRONTEND_BOOTSTRAP_PROBE_SCRIPT)
  })

  it('polls at the given intervalMs and stops as soon as the probe reports true', async () => {
    vi.useFakeTimers()
    const wc = createMockWc()
    wc.executeJavaScript
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    let result: boolean | undefined
    whenFrontendBootstrapped(asWc(wc), { intervalMs: 100, timeoutMs: 10000 }).then((r) => { result = r })

    await vi.advanceTimersByTimeAsync(0)
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(result).toBeUndefined()

    await vi.advanceTimersByTimeAsync(100)
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(2)
    expect(result).toBeUndefined()

    await vi.advanceTimersByTimeAsync(100)
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(3)
    expect(result).toBe(true)
  })

  it('defaults to a 150ms polling interval when opts.intervalMs is omitted', async () => {
    vi.useFakeTimers()
    const wc = createMockWc()
    wc.executeJavaScript.mockResolvedValue(false)
    void whenFrontendBootstrapped(asWc(wc))

    await vi.advanceTimersByTimeAsync(0)
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(149)
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(2)
  })

  it('resolves false after the default 45000ms timeout elapses, and logs exactly one bootstrap warning', async () => {
    // Default aligned with the e2e suite's own 45s bootstrap-wait window so a
    // slow-but-alive bootstrap never lands in a band where production gave up
    // while the spec still expects the injections.
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wc = createMockWc()
    wc.executeJavaScript.mockResolvedValue(false)

    const resultPromise = whenFrontendBootstrapped(asWc(wc))
    await vi.advanceTimersByTimeAsync(45000)

    await expect(resultPromise).resolves.toBe(false)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.join(' ')).toMatch(/bootstrap/i)
  })

  it('still resolves false at the deadline when a probe call HANGS (never settles) — the timeout is an independent timer, not a check inside the poll chain', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wc = createMockWc()
    wc.executeJavaScript.mockImplementation(() => new Promise(() => {}))

    const resultPromise = whenFrontendBootstrapped(asWc(wc), { timeoutMs: 300, intervalMs: 100 })
    await vi.advanceTimersByTimeAsync(300)

    await expect(resultPromise).resolves.toBe(false)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(wc.executeJavaScript, 'the hung first probe blocks the poll chain — only the independent deadline can settle the promise').toHaveBeenCalledTimes(1)
  })

  it('honors a custom timeoutMs instead of the 15000ms default', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wc = createMockWc()
    wc.executeJavaScript.mockResolvedValue(false)

    const resultPromise = whenFrontendBootstrapped(asWc(wc), { timeoutMs: 500, intervalMs: 100 })
    await vi.advanceTimersByTimeAsync(500)

    await expect(resultPromise).resolves.toBe(false)
  })

  it('leaves no live timer behind after resolving false on timeout', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wc = createMockWc()
    wc.executeJavaScript.mockResolvedValue(false)

    const resultPromise = whenFrontendBootstrapped(asWc(wc), { timeoutMs: 300, intervalMs: 100 })
    await vi.advanceTimersByTimeAsync(300)
    await expect(resultPromise).resolves.toBe(false)

    const callsAtTimeout = wc.executeJavaScript.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(callsAtTimeout)
  })

  it('resolves false without ever probing when wc is already destroyed at call time', async () => {
    const wc = createMockWc(true)

    await expect(whenFrontendBootstrapped(asWc(wc))).resolves.toBe(false)
    expect(wc.executeJavaScript).not.toHaveBeenCalled()
  })

  it('resolves false and stops polling the moment wc is destroyed mid-poll, leaving no live timer', async () => {
    vi.useFakeTimers()
    const wc = createMockWc()
    wc.executeJavaScript.mockResolvedValue(false)

    const resultPromise = whenFrontendBootstrapped(asWc(wc), { intervalMs: 100, timeoutMs: 10000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(1)

    wc.setDestroyed(true)
    await vi.advanceTimersByTimeAsync(100)
    await expect(resultPromise).resolves.toBe(false)

    const callsAtDestroy = wc.executeJavaScript.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(callsAtDestroy)
  })

  it('treats a rejected probe call as false and keeps polling instead of failing', async () => {
    vi.useFakeTimers()
    const wc = createMockWc()
    wc.executeJavaScript
      .mockRejectedValueOnce(new Error('execution context was destroyed'))
      .mockResolvedValueOnce(true)

    const resultPromise = whenFrontendBootstrapped(asWc(wc), { intervalMs: 100, timeoutMs: 10000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(100)
    await expect(resultPromise).resolves.toBe(true)
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(2)
  })

  it('never rejects even when every probe call rejects all the way through to timeout', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wc = createMockWc()
    wc.executeJavaScript.mockRejectedValue(new Error('boom'))

    const resultPromise = whenFrontendBootstrapped(asWc(wc), { timeoutMs: 300, intervalMs: 100 })
    await vi.advanceTimersByTimeAsync(300)

    await expect(resultPromise).resolves.toBe(false)
  })
})
