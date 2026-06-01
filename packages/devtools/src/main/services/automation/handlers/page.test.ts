/**
 * Tests for automation/handlers/page.ts — Page.getData NATIVE branch.
 *
 * Native contract:
 *   - bridgeId = ctx.bridge.getActiveBridgeId()
 *   - appdata  = bridgeId ? (ctx.appData?.getPageData(bridgeId) ?? {}) : {}
 *   - no params.path → { data: appdata }
 *   - params.path → traverse identically to the default branch (`a.b`, `a[0].b`)
 *     and return { data: <value-or-undefined> }.
 *
 * These pin that reactive page data is sourced from ctx.appData.getPageData under
 * native-host. The branch reads neither exec.js nor registry.js, but we stub them
 * so importing the handler module does not pull electron / DOM deps.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WorkbenchContext } from '../../workbench-context.js'

// exec.js / registry.js are unused by the native branch — stub so the import is clean.
vi.mock('../exec.js', () => ({
  evalInActivePage: vi.fn(),
  evalInSim: vi.fn(),
}))
vi.mock('../registry.js', () => ({
  registerElement: vi.fn(),
}))

import { pageHandlers } from './page.js'

const PAGE_DATA = { user: { name: 'amy' }, items: [{ id: 7 }] }

/** Native-host ctx: bridge.isNativeHost() true, getPageData keyed on bridgeId. */
function makeNativeCtx(activeBridgeId: string | null): WorkbenchContext {
  return {
    bridge: {
      isNativeHost: () => true,
      getActiveBridgeId: () => activeBridgeId,
    },
    appData: {
      getPageData: (id: string) => (id === 'b1' ? PAGE_DATA : {}),
    },
  } as unknown as WorkbenchContext
}

async function getData(ctx: WorkbenchContext, params: Record<string, unknown>) {
  return pageHandlers['Page.getData']!(ctx, params) as Promise<{ data: unknown }>
}

describe('Page.getData — native-host branch reads ctx.appData.getPageData', () => {
  it('returns the full active-bridge page object when no path is given', async () => {
    const ctx = makeNativeCtx('b1')
    const res = await getData(ctx, {})
    expect(res).toEqual({ data: PAGE_DATA })
  })

  it("resolves a dotted path ('user.name')", async () => {
    const ctx = makeNativeCtx('b1')
    const res = await getData(ctx, { path: 'user.name' })
    expect(res).toEqual({ data: 'amy' })
  })

  it("resolves an indexed path ('items[0].id')", async () => {
    const ctx = makeNativeCtx('b1')
    const res = await getData(ctx, { path: 'items[0].id' })
    expect(res).toEqual({ data: 7 })
  })

  it('returns undefined for a path that does not exist', async () => {
    const ctx = makeNativeCtx('b1')
    const res = await getData(ctx, { path: 'user.missing.deep' })
    expect(res).toEqual({ data: undefined })
  })

  it('returns { data: {} } when getActiveBridgeId() is null (never calls getPageData)', async () => {
    const getPageData = vi.fn(() => PAGE_DATA)
    const ctx = {
      bridge: { isNativeHost: () => true, getActiveBridgeId: () => null },
      appData: { getPageData },
    } as unknown as WorkbenchContext

    const res = await getData(ctx, {})
    expect(res).toEqual({ data: {} })
    expect(getPageData).not.toHaveBeenCalled()
  })

  it('passes the active bridgeId through to getPageData', async () => {
    const getPageData = vi.fn((id: string) => (id === 'b1' ? PAGE_DATA : {}))
    const ctx = {
      bridge: { isNativeHost: () => true, getActiveBridgeId: () => 'b1' },
      appData: { getPageData },
    } as unknown as WorkbenchContext

    await getData(ctx, {})
    expect(getPageData).toHaveBeenCalledWith('b1')
  })
})
