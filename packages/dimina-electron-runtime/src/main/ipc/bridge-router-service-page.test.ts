import { describe, expect, it, vi } from 'vitest'

// `resolveServiceDefaultPage` is imported from the real module, so its
// top-level `import ... from 'electron'` must resolve before anything else
// runs. Mirrors the minimal stub verified in bridge-router-multi-window.test.ts
// — a fuller mock (e.g. one that imports another module which itself reads
// from `electron`) can deadlock the whole run silently at import time instead
// of failing fast.
vi.mock('electron', () => ({
  app: { isReady: () => true, on: vi.fn(), getLocale: () => 'zh-CN' },
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), removeListener: vi.fn(), listenerCount: () => 0 },
  protocol: { handle: vi.fn(), unhandle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  session: { fromPartition: vi.fn(() => ({ protocol: { handle: vi.fn(), unhandle: vi.fn() }, setPermissionRequestHandler: vi.fn(), webRequest: { onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() } })) },
  webContents: { fromId: () => null, getAllWebContents: () => [] },
  default: {},
}))

vi.mock('../services/dmb-resource/handle-request.js', () => ({
  handleDmbResourceRequest: () => Promise.resolve(new Response('')),
}))

import { resolveServiceDefaultPage } from './bridge-router.js'

// Infer the page-session shape from the function's own signature instead of
// importing `PageSession` — it isn't exported, and a real instance carries a
// live WebContents this test has no reason to fake.
type ResolveState = Parameters<typeof resolveServiceDefaultPage>[0]
type ResolveApp = Parameters<typeof resolveServiceDefaultPage>[1]
type ResolvedPage = NonNullable<ReturnType<typeof resolveServiceDefaultPage>>

function fakePage(label: string): ResolvedPage {
  return { label } as unknown as ResolvedPage
}

function state(pages: Array<[string, ResolvedPage]>): ResolveState {
  return { pageSessions: new Map(pages) }
}

function app(activeBridgeId: string | null, pages: Array<[string, ResolvedPage]>): ResolveApp {
  return { activeBridgeId, pages: new Map(pages) }
}

describe('resolveServiceDefaultPage', () => {
  it('routes to the page named by bridgeId when it is still open', () => {
    const root = fakePage('root')
    const s = state([['root-bridge', root]])
    const ap = app('root-bridge', [['root-bridge', root]])

    expect(resolveServiceDefaultPage(s, ap, 'root-bridge')).toBe(root)
  })

  // The bug: preload only ever sends the session-root bridgeId. Once a
  // navigation (reLaunch/redirectTo/dropping the root via switchTab) disposes
  // that root page, `pageSessions` no longer has an entry for it — the old
  // code returned undefined here and every later service→container message
  // (navigateTo, getSystemInfo, async storage) was dropped with no success,
  // no fail, no diagnostic.
  it('falls back to the session current active page once the named bridgeId is gone', () => {
    const current = fakePage('current')
    const s = state([['current-bridge', current]])
    // The stale root bridgeId the service preload still sends is no longer a
    // known page session; `activeBridgeId` tracks where the session actually is.
    const ap = app('current-bridge', [['current-bridge', current]])

    expect(resolveServiceDefaultPage(s, ap, 'stale-root-bridge')).toBe(current)
  })

  it('falls back to the newest surviving page when activeBridgeId itself is stale or unset', () => {
    const older = fakePage('older')
    const newer = fakePage('newer')
    const s = state([
      ['older-bridge', older],
      ['newer-bridge', newer],
    ])
    // activeBridgeId points at a page session that has already been disposed —
    // the resolver must not surface that dangling id as the answer.
    const apWithStaleActive = app('disposed-bridge', [
      ['older-bridge', older],
      ['newer-bridge', newer],
    ])
    expect(resolveServiceDefaultPage(s, apWithStaleActive, 'gone-bridge')).toBe(newer)

    const apWithNoActive = app(null, [
      ['older-bridge', older],
      ['newer-bridge', newer],
    ])
    expect(resolveServiceDefaultPage(s, apWithNoActive, 'gone-bridge')).toBe(newer)
  })

  it('resolves to nothing once the session has no page left open', () => {
    const s = state([])
    const ap = app(null, [])

    expect(resolveServiceDefaultPage(s, ap, 'any-bridge')).toBeUndefined()
  })
})
