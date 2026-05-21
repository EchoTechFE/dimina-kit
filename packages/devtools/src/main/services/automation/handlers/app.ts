import type { Handler } from '../shared.js'
import { evalInSim, getSimulator, inIframe } from '../exec.js'
import { parseLocationRoute } from '../../../../shared/simulator-route.js'

export const appHandlers: Record<string, Handler> = {}

// -- App domain --

async function readRoute(ctx: Parameters<Handler>[0]) {
  const { search } = await evalInSim<{ search: string }>(
    ctx,
    `({ search: location.search })`,
  )
  return parseLocationRoute(search)
}

appHandlers['App.getCurrentPage'] = async (ctx) => {
  const route = await readRoute(ctx)
  const iframeCount = await evalInSim<number>(ctx, `document.querySelectorAll('iframe').length`)
  return {
    pageId: iframeCount,
    path: route?.current.pagePath ?? '',
    query: route?.current.query ?? {},
  }
}

appHandlers['App.getPageStack'] = async (ctx) => {
  const route = await readRoute(ctx)
  const pageStack: Array<{ pageId: number; path: string; query: Record<string, string> }> = []
  if (!route) return { pageStack }

  // Mirrors upstream HashRouter.parseSearch: `[entry]` or `[entry, current]`.
  pageStack.push({ pageId: 1, path: route.entry.pagePath, query: route.entry.query })
  if (route.current.pagePath !== route.entry.pagePath) {
    pageStack.push({ pageId: 2, path: route.current.pagePath, query: route.current.query })
  }
  return { pageStack }
}

appHandlers['App.callWxMethod'] = async (ctx, params) => {
  const method = params.method as string
  const args = (params.args as unknown[]) || []

  // For navigation methods, handle specially via DOM click / wx.* on the iframe
  if (['navigateTo', 'redirectTo', 'reLaunch', 'switchTab'].includes(method)) {
    const opts = args[0] as { url?: string } | undefined
    const url = opts?.url
    if (url) {
      const cleanUrl = url.startsWith('/') ? url : `/${url}`
      // Try clicking a matching DOM element first
      const clicked = await evalInSim<boolean>(ctx, inIframe(`
        const el = _doc.querySelector('[data-path="${cleanUrl}"]')
        if (el) { el.click(); return true }
        return false
      `)).catch(() => false)

      if (!clicked) {
        // Fallback: drive navigation via wx.* on the rendered page iframe.
        // Upstream's query router doesn't react to URL mutation; the active
        // page's iframe exposes wx.* with the live dimina runtime bindings.
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
          })()`,
        )
      }
      // Wait for navigation
      await new Promise((r) => setTimeout(r, 2000))
    }
    return { result: undefined }
  }

  // For navigateBack
  if (method === 'navigateBack') {
    await evalInSim(ctx, 'history.back()')
    await new Promise((r) => setTimeout(r, 1500))
    return { result: undefined }
  }

  // General wx method call
  const argsStr = args.map((a) => JSON.stringify(a)).join(', ')

  // Async wx methods with success/fail callbacks
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
