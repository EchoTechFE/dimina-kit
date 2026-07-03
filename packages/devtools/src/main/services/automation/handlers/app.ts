import type { WebContents } from 'electron'
import type { Handler } from '../shared.js'
import { evalInSim, getActivePageWc, getSimulator } from '../exec.js'
import { decodePageSpec, parseLocationRoute } from '../../../../shared/simulator-route.js'
import { waitForActivePage } from '../wait-active-page.js'

export const appHandlers: Record<string, Handler> = {}

type CtxParam = Parameters<Handler>[0]
type Bridge = NonNullable<CtxParam['bridge']>

/** Nav methods that take a `{ url }` arg (navigateBack is handled separately). */
const NAV_METHODS = new Set(['navigateTo', 'redirectTo', 'reLaunch', 'switchTab'])

// -- App domain --

async function readRoute(ctx: Parameters<Handler>[0]) {
  const { search } = await evalInSim<{ search: string }>(
    ctx,
    `({ search: location.search })`,
  )
  return parseLocationRoute(search)
}

/**
 * Native-host: derive the visible page's `{ pagePath, query }` from the active
 * render guest. The page-stack depth isn't surfaced by the bridge handle, so the
 * native page stack is reported as the single active page (see App.getPageStack).
 * Reads the guest's own `location.search` — the render-host preload encodes
 * `pagePath` (+ per-page query) there.
 */
async function readNativeActivePage(ctx: Parameters<Handler>[0]) {
  const renderWc = getActivePageWc(ctx)
  if (!renderWc) return null
  const search = await renderWc
    .executeJavaScript('location.search')
    .catch(() => '') as string
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const pagePath = params.get('pagePath') || ''
  if (!pagePath) return null
  // The guest URL carries the full page spec on `pagePath` (may include `?k=v`).
  const spec = decodePageSpec(pagePath)
  return { pagePath: spec.pagePath, query: spec.query }
}

appHandlers['App.getCurrentPage'] = async (ctx) => {
  if (ctx.bridge?.isNativeHost()) {
    const page = await readNativeActivePage(ctx)
    return { pageId: 1, path: page?.pagePath ?? '', query: page?.query ?? {} }
  }
  const route = await readRoute(ctx)
  const iframeCount = await evalInSim<number>(ctx, `document.querySelectorAll('iframe').length`)
  return {
    pageId: iframeCount,
    path: route?.current.pagePath ?? '',
    query: route?.current.query ?? {},
  }
}

appHandlers['App.getPageStack'] = async (ctx) => {
  const pageStack: Array<{ pageId: number; path: string; query: Record<string, string> }> = []
  if (ctx.bridge?.isNativeHost()) {
    // DeviceShell reports its full ordered stack (bottom→top) via PAGE_STACK;
    // the bridge stores it. Report that. Before the first signal (or in a mock
    // without the accessor) fall back to the single visible page.
    const stack = ctx.bridge.getPageStack?.()
    if (stack && stack.length > 0) {
      stack.forEach((entry, i) => {
        pageStack.push({
          pageId: i + 1,
          path: entry.pagePath,
          query: Object.fromEntries(
            Object.entries(entry.query ?? {}).map(([k, v]) => [k, String(v)]),
          ),
        })
      })
      return { pageStack }
    }
    const page = await readNativeActivePage(ctx)
    if (page) pageStack.push({ pageId: 1, path: page.pagePath, query: page.query })
    return { pageStack }
  }

  const route = await readRoute(ctx)
  if (!route) return { pageStack }

  // Mirrors upstream HashRouter.parseSearch: `[entry]` or `[entry, current]`.
  pageStack.push({ pageId: 1, path: route.entry.pagePath, query: route.entry.query })
  if (route.current.pagePath !== route.entry.pagePath) {
    pageStack.push({ pageId: 2, path: route.current.pagePath, query: route.current.query })
  }
  return { pageStack }
}

/** Nav (incl. navigateBack) on the native-host service-host `wx`, waiting for the page to actually change. */
async function runNativeHostNav(
  bridge: Bridge,
  serviceWc: WebContents,
  method: string,
  args: unknown[],
): Promise<{ result: unknown }> {
  const arg = method === 'navigateBack'
    ? (args[0] ?? { delta: 1 })
    : (args[0] ?? {})
  // Capture the active page BEFORE navigating so we can wait for it to
  // actually change, instead of blindly sleeping a fixed duration.
  const since = bridge.getActiveBridgeId()
  await serviceWc.executeJavaScript(`wx.${method}(${JSON.stringify(arg)})`)
  // Wait for the bridge's `activePage` signal (the new page mounted), with a
  // timeout floor = the old blind-wait duration. Resolves as soon as the new
  // page is active — far faster than the fixed sleep for the common case —
  // and still bounded for edges (e.g. switchTab back to an already-mounted
  // tab keeps the same bridgeId, so it falls through to the floor, same as
  // the old behaviour). See wait-active-page.ts.
  const timeoutMs = method === 'navigateBack' ? 1500 : 2000
  await waitForActivePage(bridge, {
    since,
    timeoutMs,
    onTimeout: () =>
      console.warn(`[automation] ${method}: activePage signal not seen within ${timeoutMs}ms — proceeding on timeout floor`),
  })
  return { result: undefined }
}

/**
 * Non-nav `wx.*` on the native-host service-host, returning its (sync) value.
 * Async methods that report via a success callback return undefined here,
 * same as the default-arch generic path (`runSimulatorGeneric`).
 */
async function runNativeHostGeneric(serviceWc: WebContents, method: string, args: unknown[]): Promise<{ result: unknown }> {
  const argsStr = args.map((a) => JSON.stringify(a)).join(', ')
  const result = await serviceWc.executeJavaScript(`
    new Promise((resolve, reject) => {
      try {
        if (typeof wx === 'undefined' || typeof wx[${JSON.stringify(method)}] !== 'function') {
          reject(new Error('wx.' + ${JSON.stringify(method)} + ' is not a function in service host'))
          return
        }
        resolve(wx.${method}(${argsStr}))
      } catch (e) { reject(e && e.message ? e.message : String(e)) }
    })
  `)
  return { result }
}

/**
 * NATIVE-HOST: the authoritative `wx.*` runs in the hidden service-host
 * window (the simulator / render-guest context has no `wx`). Run EVERY method
 * there — nav so the page stack goes through the real runtime path, and
 * non-nav (setNavigationBarTitle / getSystemInfoSync / tabBar APIs / …) so
 * they don't fall through to the default-arch eval-in-simulator path, which
 * throws "wx is not defined" under native-host.
 */
async function runNativeHostWxMethod(bridge: Bridge, method: string, args: unknown[]): Promise<{ result: unknown }> {
  const serviceWc = bridge.getServiceWc()
  if (!serviceWc) throw new Error('Service host not connected')
  if (NAV_METHODS.has(method) || method === 'navigateBack') {
    return runNativeHostNav(bridge, serviceWc, method, args)
  }
  return runNativeHostGeneric(serviceWc, method, args)
}

/**
 * Try clicking a matching DOM element for a nav target. We can't use
 * `inIframe` here — tabBar mini-apps keep prior tabs' iframes around
 * (display:none) and `iframes[length-1]` ends up being the hidden,
 * freshly-cached tab rather than the visible one. Pick the visible iframe
 * explicitly.
 */
async function clickNavTarget(ctx: CtxParam, cleanUrl: string): Promise<boolean> {
  return evalInSim<boolean>(ctx, `(() => {
    const iframes = Array.from(document.querySelectorAll('iframe'))
    const visible = iframes.filter((f) => {
      const cs = window.getComputedStyle(f)
      if (cs.display === 'none' || cs.visibility === 'hidden') return false
      const rect = f.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })
    const target = visible[visible.length - 1] || iframes[iframes.length - 1]
    if (!target || !target.contentDocument) return false
    const path = ${JSON.stringify(cleanUrl)}
    const el = Array.from(target.contentDocument.querySelectorAll('[data-path]'))
      .find((e) => e.getAttribute('data-path') === path)
    if (el) { el.click(); return true }
    return false
  })()`).catch(() => false)
}

/**
 * Fallback cascade for navigation methods when no matching DOM element was
 * found to click:
 *   1. iframe wx[method] — page-iframe surface (older arch, where jdimina
 *      installed `window.wx` on each page frame).
 *   2. top-window wx[method] — set up by simulator/main.tsx, binds
 *      MiniApp.switchTab / navigateTo / etc. Required for switchTab since
 *      page-iframe wx (jdimina) doesn't expose it.
 */
async function invokeNavViaWx(ctx: CtxParam, method: string, cleanUrl: string): Promise<void> {
  const apiName = JSON.stringify(method)
  const urlJson = JSON.stringify(cleanUrl)
  await evalInSim(
    ctx,
    `(() => {
      const iframes = Array.from(document.querySelectorAll('iframe'))
      for (const f of iframes) {
        try {
          if (f.contentWindow && f.contentWindow.wx && typeof f.contentWindow.wx[${apiName}] === 'function') {
            f.contentWindow.wx[${apiName}]({ url: ${urlJson} })
            return
          }
        } catch (_) {}
      }
      if (typeof wx !== 'undefined' && wx && typeof wx[${apiName}] === 'function') {
        wx[${apiName}]({ url: ${urlJson} })
      }
    })()`,
  )
}

/** Default-arch nav: handled via DOM click / wx.* on the iframe. */
async function runSimulatorNav(ctx: CtxParam, method: string, args: unknown[]): Promise<{ result: unknown }> {
  const opts = args[0] as { url?: string } | undefined
  const url = opts?.url
  if (!url) return { result: undefined }
  const cleanUrl = url.startsWith('/') ? url : `/${url}`
  const clicked = await clickNavTarget(ctx, cleanUrl)
  if (!clicked) {
    await invokeNavViaWx(ctx, method, cleanUrl)
  }
  // Wait for navigation
  await new Promise((r) => setTimeout(r, 2000))
  return { result: undefined }
}

async function runSimulatorNavigateBack(ctx: CtxParam): Promise<{ result: unknown }> {
  await evalInSim(ctx, 'history.back()')
  await new Promise((r) => setTimeout(r, 1500))
  return { result: undefined }
}

/** General wx method call — async wx methods with success/fail callbacks. */
async function runSimulatorGeneric(ctx: CtxParam, method: string, args: unknown[]): Promise<{ result: unknown }> {
  const argsStr = args.map((a) => JSON.stringify(a)).join(', ')
  const result = await evalInSim(ctx, `
    new Promise((resolve, reject) => {
      try {
        const r = wx.${method}(${argsStr})
        resolve(r)
      } catch(e) {
        reject(e)
      }
    })
  `)
  return { result }
}

appHandlers['App.callWxMethod'] = async (ctx, params) => {
  const method = params.method as string
  const args = (params.args as unknown[]) || []

  const bridge = ctx.bridge
  if (bridge?.isNativeHost()) {
    return runNativeHostWxMethod(bridge, method, args)
  }
  if (NAV_METHODS.has(method)) {
    return runSimulatorNav(ctx, method, args)
  }
  if (method === 'navigateBack') {
    return runSimulatorNavigateBack(ctx)
  }
  return runSimulatorGeneric(ctx, method, args)
}

appHandlers['App.callFunction'] = async (ctx, params) => {
  const fnDecl = params.functionDeclaration as string
  const args = (params.args as unknown[]) || []
  const argsStr = args.map((a) => JSON.stringify(a)).join(', ')
  const result = await evalInSim(ctx, `
    Promise.resolve((${fnDecl})(${argsStr}))
  `)
  return { result }
}

appHandlers['App.captureScreenshot'] = async (ctx) => {
  const sim = getSimulator(ctx)
  if (!sim) throw new Error('Simulator not connected')
  const img = await sim.capturePage()
  return { data: img.toPNG().toString('base64') }
}

appHandlers['App.enableLog'] = async () => ({})

appHandlers['App.exit'] = async (ctx) => {
  await ctx.workspace.closeProject()
  return {}
}

appHandlers['App.mockWxMethod'] = async () => {
  throw new Error('mockWxMethod is not supported (requires AppService layer)')
}

appHandlers['App.addBinding'] = async () => {
  throw new Error('exposeFunction is not supported (requires AppService layer)')
}
