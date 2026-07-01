/**
 * Behavior tests for createRenderInspector.
 *
 * The inspector injects a guest-side IIFE (the `__diminaRenderInspect` API) into
 * a render-host <webview>'s main world via `executeJavaScript`, then drives it
 * to read the WXML tree and highlight/unhighlight elements by sid.
 *
 * Contract verified here:
 *   - the IIFE source is injected exactly ONCE per WebContents (de-duped by id),
 *     even across multiple getWxml/highlight calls; a different wc id gets its
 *     own injection
 *   - getWxml/highlight call into `__diminaRenderInspect` and return the guest
 *     result, or null when the guest call rejects (never throw)
 *   - unhighlight calls `unhighlightElement` and swallows rejection
 *   - a destroyed wc short-circuits to null/no-op WITHOUT executeJavaScript
 *   - when the wc emits 'destroyed', a new wc reusing the same id re-injects
 *
 * No electron import is required — the inspector takes a FAKE WebContents.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderInspector } from './index.js'

const IIFE_SOURCE = '/*inspect-iife*/'

/** A fake of `wc.debugger` exposing the surface the inspector drives over CDP. */
interface FakeDebugger {
  isAttached: ReturnType<typeof vi.fn>
  attach: ReturnType<typeof vi.fn>
  detach: ReturnType<typeof vi.fn>
  sendCommand: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
}

interface FakeWc {
  id: number
  isDestroyed: ReturnType<typeof vi.fn>
  executeJavaScript: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  debugger: FakeDebugger
}

/** Record of every sendCommand invocation as a `[method, params]` tuple. */
type SentCommand = [string, unknown]

/**
 * Per-method override map for the debugger `sendCommand` fake. A method name
 * maps to a function returning the Promise that command should resolve/reject
 * with; absent methods fall back to resolving `{}`.
 */
type SendCommandOverrides = Record<string, (params?: unknown) => Promise<unknown>>

/** Captured `once('destroyed', cb)` handlers per fake wc, so tests can fire them. */
function makeWc(id: number): FakeWc & {
  fireDestroyed: () => void
  sent: SentCommand[]
  setSendCommand: (overrides: SendCommandOverrides) => void
} {
  const destroyedCbs: Array<() => void> = []
  const sent: SentCommand[] = []
  let overrides: SendCommandOverrides = {}

  const dbg: FakeDebugger = {
    // Reuse path is the common case: the guest debugger is already attached by
    // the Elements forwarder, so the inspector must NOT attach a second session.
    isAttached: vi.fn(() => true),
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(async (method: string, params?: unknown) => {
      sent.push([method, params])
      const override = overrides[method]
      if (override) return override(params)
      return {}
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  }

  const wc: FakeWc = {
    id,
    isDestroyed: vi.fn(() => false),
    // Default: the injection call resolves to undefined, the driver call
    // returns a sentinel the assertions can recognise. Individual tests
    // override with mockResolvedValueOnce / mockRejectedValueOnce.
    executeJavaScript: vi.fn(async () => undefined),
    once: vi.fn((event: string, cb: () => void) => {
      if (event === 'destroyed') destroyedCbs.push(cb)
    }),
    debugger: dbg,
  }
  return Object.assign(wc, {
    sent,
    setSendCommand: (next: SendCommandOverrides) => {
      overrides = next
    },
    fireDestroyed: () => {
      for (const cb of destroyedCbs) cb()
    },
  })
}

/** A resolved `Runtime.evaluate` shape carrying the CDP objectId. */
function evaluateResult(objectId: string): unknown {
  return { result: { objectId } }
}

function asWc(wc: FakeWc): import('electron').WebContents {
  return wc as unknown as import('electron').WebContents
}

/** Concatenate every executeJavaScript code argument into one string. */
function allCode(wc: FakeWc): string {
  return wc.executeJavaScript.mock.calls.map((c) => String(c[0])).join('\n')
}

let inspector: ReturnType<typeof createRenderInspector>

beforeEach(() => {
  inspector = createRenderInspector({ loadSource: () => IIFE_SOURCE })
})

describe('createRenderInspector — injection', () => {
  it('injects the IIFE source exactly once per wc across multiple calls', async () => {
    const wc = makeWc(1)
    await inspector.getWxml(asWc(wc))
    await inspector.getWxml(asWc(wc))
    await inspector.highlight(asWc(wc), 'devtools-1')

    const injections = wc.executeJavaScript.mock.calls.filter(
      (c) => String(c[0]) === IIFE_SOURCE,
    )
    expect(injections.length).toBe(1)
  })

  it('injects separately for two different wc ids', async () => {
    const a = makeWc(1)
    const b = makeWc(2)
    await inspector.getWxml(asWc(a))
    await inspector.getWxml(asWc(b))

    expect(a.executeJavaScript.mock.calls.some((c) => String(c[0]) === IIFE_SOURCE)).toBe(true)
    expect(b.executeJavaScript.mock.calls.some((c) => String(c[0]) === IIFE_SOURCE)).toBe(true)
  })

  it('re-injects on a new wc reusing the same id after destroyed fires', async () => {
    const first = makeWc(7)
    await inspector.getWxml(asWc(first))
    // Simulate the original wc being destroyed; the injected-set entry for id=7
    // must be cleared.
    first.fireDestroyed()

    const second = makeWc(7)
    await inspector.getWxml(asWc(second))
    const injections = second.executeJavaScript.mock.calls.filter(
      (c) => String(c[0]) === IIFE_SOURCE,
    )
    expect(injections.length).toBe(1)
  })
})

describe('createRenderInspector — getWxml', () => {
  it('drives __diminaRenderInspect.getWxml and returns the guest tree', async () => {
    const tree = { tagName: 'view', attrs: {}, children: [] }
    const wc = makeWc(1)
    // First call = injection (undefined), second = the getWxml driver call.
    wc.executeJavaScript.mockResolvedValueOnce(undefined).mockResolvedValueOnce(tree)

    const result = await inspector.getWxml(asWc(wc))

    expect(result).toEqual(tree)
    const code = allCode(wc)
    expect(code).toContain('__diminaRenderInspect')
    expect(code).toContain('getWxml')
  })

  it('resolves null (no throw) when the guest call rejects', async () => {
    const wc = makeWc(1)
    wc.executeJavaScript
      .mockResolvedValueOnce(undefined) // injection
      .mockRejectedValueOnce(new Error('guest boom')) // getWxml

    await expect(inspector.getWxml(asWc(wc))).resolves.toBeNull()
  })

  it('returns null and does NOT call executeJavaScript on a destroyed wc', async () => {
    const wc = makeWc(1)
    wc.isDestroyed.mockReturnValue(true)

    const result = await inspector.getWxml(asWc(wc))

    expect(result).toBeNull()
    expect(wc.executeJavaScript).not.toHaveBeenCalled()
  })
})

describe('createRenderInspector — highlight', () => {
  // The injected guest API still computes the inspection geometry by sid; only
  // the visual draw moved off executeJavaScript onto a CDP Overlay command.
  it('drives the guest inspection by JSON-encoded sid and returns the result', async () => {
    const inspection = { sid: 'devtools-3', rect: { x: 0, y: 0, width: 1, height: 1 } }
    const wc = makeWc(1)
    wc.executeJavaScript.mockResolvedValueOnce(undefined).mockResolvedValueOnce(inspection)

    const result = await inspector.highlight(asWc(wc), 'devtools-3')

    expect(result).toEqual(inspection)
    const code = allCode(wc)
    expect(code).toContain(JSON.stringify('devtools-3'))
  })

  it('resolves null when the guest highlight call rejects', async () => {
    const wc = makeWc(1)
    wc.executeJavaScript
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('guest boom'))

    await expect(inspector.highlight(asWc(wc), 'devtools-3')).resolves.toBeNull()
  })

  it('returns null and does NOT call executeJavaScript on a destroyed wc', async () => {
    const wc = makeWc(1)
    wc.isDestroyed.mockReturnValue(true)

    const result = await inspector.highlight(asWc(wc), 'devtools-3')

    expect(result).toBeNull()
    expect(wc.executeJavaScript).not.toHaveBeenCalled()
  })
})

describe('createRenderInspector — highlight draws the native CDP Overlay', () => {
  /** Wire a wc whose injected guest API yields an inspection for the given sid. */
  function wcWithInspection(id: number, inspection: unknown) {
    const wc = makeWc(id)
    wc.executeJavaScript.mockResolvedValueOnce(undefined).mockResolvedValueOnce(inspection)
    return wc
  }

  const INSPECTION = {
    sid: 'devtools-9',
    rect: { x: 1, y: 2, width: 3, height: 4 },
    style: {},
  }

  it('reuses an already-attached debugger and does not attach a second session', async () => {
    const wc = wcWithInspection(1, INSPECTION)
    wc.debugger.isAttached.mockReturnValue(true)
    wc.setSendCommand({ 'Runtime.evaluate': async () => evaluateResult('OBJ-1') })

    await inspector.highlight(asWc(wc), 'devtools-9')

    expect(wc.debugger.attach).not.toHaveBeenCalled()
  })

  it('attaches the 1.3 protocol only when the debugger is not yet attached', async () => {
    const wc = wcWithInspection(1, INSPECTION)
    wc.debugger.isAttached.mockReturnValue(false)
    wc.setSendCommand({ 'Runtime.evaluate': async () => evaluateResult('OBJ-1') })

    await inspector.highlight(asWc(wc), 'devtools-9')

    expect(wc.debugger.attach).toHaveBeenCalledWith('1.3')
  })

  it('enables DOM before Overlay — Overlay.enable is not sent while DOM.enable hangs', async () => {
    const wc = wcWithInspection(1, INSPECTION)
    // DOM.enable never resolves; Chromium rejects Overlay.enable unless DOM is
    // enabled first, so the inspector must gate Overlay.enable behind DOM.enable.
    wc.setSendCommand({
      'DOM.enable': () => new Promise<unknown>(() => {}),
      'Runtime.evaluate': async () => evaluateResult('OBJ-1'),
    })

    await inspector.highlight(asWc(wc), 'devtools-9')

    const methods = wc.sent.map(([method]) => method)
    expect(methods).toContain('DOM.enable')
    expect(methods).not.toContain('Overlay.enable')
  })

  it('resolves the element to an objectId via Runtime.evaluate (returnByValue:false)', async () => {
    const wc = wcWithInspection(1, INSPECTION)
    wc.setSendCommand({ 'Runtime.evaluate': async () => evaluateResult('OBJ-1') })

    await inspector.highlight(asWc(wc), 'devtools-9')

    const evaluate = wc.sent.find(([method]) => method === 'Runtime.evaluate')
    expect(evaluate).toBeDefined()
    expect(evaluate?.[1]).toMatchObject({ returnByValue: false })
  })

  it('feeds the Runtime.evaluate objectId into Overlay.highlightNode with a highlightConfig', async () => {
    const wc = wcWithInspection(1, INSPECTION)
    wc.setSendCommand({ 'Runtime.evaluate': async () => evaluateResult('OBJ-FROM-EVAL') })

    await inspector.highlight(asWc(wc), 'devtools-9')

    const evalIdx = wc.sent.findIndex(([method]) => method === 'Runtime.evaluate')
    const hlIdx = wc.sent.findIndex(([method]) => method === 'Overlay.highlightNode')
    expect(evalIdx).toBeGreaterThanOrEqual(0)
    expect(hlIdx).toBeGreaterThanOrEqual(0)
    // The highlight command carries the objectId produced by the evaluate.
    expect(hlIdx).toBeGreaterThan(evalIdx)

    const params = wc.sent[hlIdx][1] as Record<string, unknown>
    expect(params.objectId).toBe('OBJ-FROM-EVAL')
    expect(params.highlightConfig).toBeDefined()
  })

  it('returns the inspection even when the debugger draw rejects (data survives a failed draw)', async () => {
    const wc = wcWithInspection(1, INSPECTION)
    wc.setSendCommand({
      'Runtime.evaluate': async () => evaluateResult('OBJ-1'),
      'Overlay.highlightNode': async () => {
        throw new Error('overlay boom')
      },
    })

    await expect(inspector.highlight(asWc(wc), 'devtools-9')).resolves.toEqual(INSPECTION)
  })

  it('never throws when any debugger step rejects', async () => {
    const wc = wcWithInspection(1, INSPECTION)
    wc.setSendCommand({
      'DOM.enable': async () => {
        throw new Error('dom boom')
      },
    })

    await expect(inspector.highlight(asWc(wc), 'devtools-9')).resolves.toEqual(INSPECTION)
  })

  it('returns null without touching the debugger when the guest yields no geometry', async () => {
    const wc = makeWc(1)
    wc.executeJavaScript.mockResolvedValueOnce(undefined).mockResolvedValueOnce(null)

    const result = await inspector.highlight(asWc(wc), 'devtools-9')

    expect(result).toBeNull()
    expect(wc.debugger.sendCommand).not.toHaveBeenCalled()
  })

  it('does NOT send Overlay.highlightNode when the guest highlight call rejects', async () => {
    const wc = makeWc(1)
    wc.executeJavaScript
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('guest boom'))

    const result = await inspector.highlight(asWc(wc), 'devtools-9')

    expect(result).toBeNull()
    const methods = wc.sent.map(([method]) => method)
    expect(methods).not.toContain('Overlay.highlightNode')
  })

  it('touches neither executeJavaScript nor the debugger on a destroyed wc', async () => {
    const wc = makeWc(1)
    wc.isDestroyed.mockReturnValue(true)

    const result = await inspector.highlight(asWc(wc), 'devtools-9')

    expect(result).toBeNull()
    expect(wc.executeJavaScript).not.toHaveBeenCalled()
    expect(wc.debugger.sendCommand).not.toHaveBeenCalled()
  })
})

/**
 * `setWxmlObserving` (final-contract.md §6) — toggles the guest-side WXML
 * MutationObserver that drives the simulator-wxml service's live-push path.
 *
 * Pinned contract:
 *   - Injects the IIFE (once per wc, same de-dupe as getWxml/highlight) BEFORE
 *     driving the guest call.
 *   - Drives `window.__diminaRenderInspect.setWxmlObserving(<on>)` with the
 *     boolean argument inlined in the executed source.
 *   - A destroyed wc is a silent no-op: no executeJavaScript call at all.
 *   - A rejected guest call never throws/rejects out of setWxmlObserving.
 */
describe('createRenderInspector — setWxmlObserving', () => {
  it('injects the IIFE once, then drives setWxmlObserving(true)', async () => {
    const wc = makeWc(1)
    wc.executeJavaScript.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)

    await (inspector as unknown as {
      setWxmlObserving: (wc: import('electron').WebContents, on: boolean) => Promise<void>
    }).setWxmlObserving(asWc(wc), true)

    const injections = wc.executeJavaScript.mock.calls.filter((c) => String(c[0]) === IIFE_SOURCE)
    expect(injections.length).toBe(1)
    const code = allCode(wc)
    expect(code).toContain('setWxmlObserving')
    expect(code).toContain('true')
  })

  it('drives setWxmlObserving(false)', async () => {
    const wc = makeWc(1)
    wc.executeJavaScript.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)

    await (inspector as unknown as {
      setWxmlObserving: (wc: import('electron').WebContents, on: boolean) => Promise<void>
    }).setWxmlObserving(asWc(wc), false)

    const code = allCode(wc)
    expect(code).toContain('setWxmlObserving')
    expect(code).toContain('false')
  })

  it('is a no-op on a destroyed wc — never calls executeJavaScript', async () => {
    const wc = makeWc(1)
    wc.isDestroyed.mockReturnValue(true)

    await expect(
      (inspector as unknown as {
        setWxmlObserving: (wc: import('electron').WebContents, on: boolean) => Promise<void>
      }).setWxmlObserving(asWc(wc), true),
    ).resolves.toBeUndefined()
    expect(wc.executeJavaScript).not.toHaveBeenCalled()
  })

  it('never throws when the guest call rejects', async () => {
    const wc = makeWc(1)
    wc.executeJavaScript
      .mockResolvedValueOnce(undefined) // injection
      .mockRejectedValueOnce(new Error('guest boom')) // driver call

    await expect(
      (inspector as unknown as {
        setWxmlObserving: (wc: import('electron').WebContents, on: boolean) => Promise<void>
      }).setWxmlObserving(asWc(wc), true),
    ).resolves.toBeUndefined()
  })
})

describe('createRenderInspector — unhighlight', () => {
  // The native overlay is cleared with Overlay.hideHighlight over the debugger.
  it('sends Overlay.hideHighlight over the debugger', async () => {
    const wc = makeWc(1)
    await inspector.unhighlight(asWc(wc))

    const methods = wc.sent.map(([method]) => method)
    expect(methods).toContain('Overlay.hideHighlight')
  })

  it('swallows debugger rejection (resolves void)', async () => {
    const wc = makeWc(1)
    wc.setSendCommand({
      'Overlay.hideHighlight': async () => {
        throw new Error('debugger boom')
      },
    })

    await expect(inspector.unhighlight(asWc(wc))).resolves.toBeUndefined()
  })

  it('is a no-op on a destroyed wc (no sendCommand)', async () => {
    const wc = makeWc(1)
    wc.isDestroyed.mockReturnValue(true)

    await inspector.unhighlight(asWc(wc))

    expect(wc.debugger.sendCommand).not.toHaveBeenCalled()
  })
})
