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

interface FakeWc {
  id: number
  isDestroyed: ReturnType<typeof vi.fn>
  executeJavaScript: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
}

/** Captured `once('destroyed', cb)` handlers per fake wc, so tests can fire them. */
function makeWc(id: number): FakeWc & { fireDestroyed: () => void } {
  const destroyedCbs: Array<() => void> = []
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
  }
  return Object.assign(wc, {
    fireDestroyed: () => {
      for (const cb of destroyedCbs) cb()
    },
  })
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
  it('drives highlightElement with the JSON-encoded sid and returns the result', async () => {
    const inspection = { sid: 'devtools-3', rect: { x: 0, y: 0, width: 1, height: 1 } }
    const wc = makeWc(1)
    wc.executeJavaScript.mockResolvedValueOnce(undefined).mockResolvedValueOnce(inspection)

    const result = await inspector.highlight(asWc(wc), 'devtools-3')

    expect(result).toEqual(inspection)
    const code = allCode(wc)
    expect(code).toContain('highlightElement')
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

describe('createRenderInspector — unhighlight', () => {
  it('drives unhighlightElement', async () => {
    const wc = makeWc(1)
    await inspector.unhighlight(asWc(wc))

    expect(allCode(wc)).toContain('unhighlightElement')
  })

  it('swallows rejection (resolves void)', async () => {
    const wc = makeWc(1)
    wc.executeJavaScript
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('guest boom'))

    await expect(inspector.unhighlight(asWc(wc))).resolves.toBeUndefined()
  })

  it('is a no-op on a destroyed wc', async () => {
    const wc = makeWc(1)
    wc.isDestroyed.mockReturnValue(true)

    await inspector.unhighlight(asWc(wc))

    expect(wc.executeJavaScript).not.toHaveBeenCalled()
  })
})
