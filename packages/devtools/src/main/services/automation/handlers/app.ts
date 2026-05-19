import type { Handler } from '../shared.js'
import { evalInSim, getSimulator, inIframe } from '../exec.js'

export const appHandlers: Record<string, Handler> = {}

// -- App domain --

// HashRouter (dimina/fe/packages/container/src/utils/hashRouter.js) encodes the
// page stack as `#{appId}|{page1}?{q1}|{page2}?{q2}|…` — each segment owns its
// own query. Splitting on `?` first would collapse the stack at any earlier
// segment that carries a query, so we split on `|` and parse per-segment.
function parseSegment(seg: string): { path: string; query: Record<string, string> } {
  const qIdx = seg.indexOf('?')
  const path = qIdx >= 0 ? seg.substring(0, qIdx) : seg
  const query: Record<string, string> = {}
  if (qIdx >= 0) {
    for (const pair of seg.substring(qIdx + 1).split('&')) {
      const [k, v] = pair.split('=')
      if (k) query[k] = decodeURIComponent(v || '')
    }
  }
  return { path, query }
}

appHandlers['App.getCurrentPage'] = async (ctx) => {
  const hash = await evalInSim<string>(ctx, 'location.hash')
  const clean = hash.replace(/^#/, '')

  // New format: #appid|page1|page2 — last segment is current page.
  // Legacy format: #appid/pagePath — strip the appid prefix.
  const lastSeg = clean.includes('|')
    ? clean.split('|').pop() ?? ''
    : clean.replace(/^[^/]*\//, '')
  const { path, query } = parseSegment(lastSeg)

  const iframeCount = await evalInSim<number>(ctx, `document.querySelectorAll('iframe').length`)
  return { pageId: iframeCount, path, query }
}

appHandlers['App.getPageStack'] = async (ctx) => {
  const hash = await evalInSim<string>(ctx, 'location.hash')
  const clean = hash.replace(/^#/, '')

  const pageStack: Array<{ pageId: number; path: string; query: Record<string, string> }> = []
  if (clean.includes('|')) {
    // New format: #appid|page1|page2 — segments after appid are pages
    const parts = clean.split('|')
    for (let i = 1; i < parts.length; i++) {
      const { path, query } = parseSegment(parts[i] ?? '')
      pageStack.push({ pageId: i, path, query })
    }
  } else {
    // Legacy format: #appid/pagePath — single page
    const seg = parseSegment(clean)
    const slashIdx = seg.path.indexOf('/')
    const currentPath = slashIdx >= 0 ? seg.path.substring(slashIdx + 1) : seg.path
    if (currentPath) {
      pageStack.push({ pageId: 1, path: currentPath, query: seg.query })
    }
  }
  return { pageStack }
}

appHandlers['App.callWxMethod'] = async (ctx, params) => {
  const method = params.method as string
  const args = (params.args as unknown[]) || []

  // For navigation methods, handle specially via hash change + click
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
        // Fallback: change hash
        const hash = await evalInSim<string>(ctx, 'location.hash')
        const appId = hash.replace(/^#/, '').split('/')[0]
        if (method === 'reLaunch' || method === 'redirectTo') {
          await evalInSim(ctx, `location.href = location.pathname + '#${appId}${cleanUrl}'`)
        } else {
          await evalInSim(ctx, `location.hash = '#${appId}${cleanUrl}'`)
        }
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
