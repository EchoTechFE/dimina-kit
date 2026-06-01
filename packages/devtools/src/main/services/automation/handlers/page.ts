import type { Handler } from '../shared.js'
import { evalInActivePage, evalInSim } from '../exec.js'
import { registerElement } from '../registry.js'

export const pageHandlers: Record<string, Handler> = {}

/**
 * Resolve a dotted/indexed path (`a.b`, `a[0].b`) against an appdata object,
 * or return the whole object when no path is given. Shared by both Page.getData
 * branches so the traversal stays identical.
 */
function resolveAppDataPath(appdata: Record<string, unknown>, pathKey: string | undefined): unknown {
  if (!pathKey) return appdata
  const keys = pathKey.replace(/\[(\d+)\]/g, '.$1').split('.')
  let val: unknown = appdata
  for (const k of keys) {
    if (val == null || typeof val !== 'object') { val = undefined; break }
    val = (val as Record<string, unknown>)[k]
  }
  return val
}

// -- Page domain --

pageHandlers['Page.getElement'] = async (ctx, params) => {
  const selector = params.selector as string
  const pageId = (params.pageId as number) || 1
  const escaped = selector.replace(/'/g, "\\'")

  const info = await evalInActivePage<{ tagName: string } | null>(ctx, `
    const el = _doc.querySelector('${escaped}')
    if (!el) return null
    return { tagName: el.tagName.toLowerCase() }
  `)

  if (!info) throw new Error(`Element not found: ${selector}`)
  const elementId = registerElement(selector, 0, pageId)
  return { elementId, tagName: info.tagName }
}

pageHandlers['Page.getElements'] = async (ctx, params) => {
  const selector = params.selector as string
  const pageId = (params.pageId as number) || 1
  const escaped = selector.replace(/'/g, "\\'")

  const items = await evalInActivePage<Array<{ tagName: string }>>(ctx, `
    return Array.from(_doc.querySelectorAll('${escaped}')).map(el => ({
      tagName: el.tagName.toLowerCase(),
    }))
  `)

  return {
    elements: items.map((item, i) => ({
      elementId: registerElement(selector, i, pageId),
      tagName: item.tagName,
    })),
  }
}

pageHandlers['Page.getData'] = async (ctx, params) => {
  const pathKey = params.path as string | undefined
  // NATIVE-HOST: under native-host the page AppData lives in the service window's
  // Worker-less runtime (tracked centrally via ctx.appData), NOT in the render
  // guest's DOM. Source the active bridge's reactive state from the central
  // accumulator, then run the SAME path traversal as the default branch.
  if (ctx.bridge?.isNativeHost()) {
    const bridgeId = ctx.bridge.getActiveBridgeId()
    const appdata = bridgeId ? (ctx.appData?.getPageData(bridgeId) ?? {}) : {}
    return { data: resolveAppDataPath(appdata, pathKey) }
  }
  const appdata = await evalInSim<Record<string, unknown>>(ctx,
    `window.__simulatorData ? window.__simulatorData.getAppdata() : {}`,
  )
  return { data: resolveAppDataPath(appdata, pathKey) }
}

pageHandlers['Page.setData'] = async () => {
  throw new Error('Page.setData is not supported (requires AppService layer)')
}

pageHandlers['Page.callMethod'] = async (_ctx, params) => {
  throw new Error(`Page.callMethod('${params.method}') is not supported (requires AppService layer)`)
}

pageHandlers['Page.getWindowProperties'] = async (ctx, params) => {
  const names = params.names as string[]
  const properties = await evalInActivePage<unknown[]>(ctx, `
    return ${JSON.stringify(names)}.map(n => {
      try { return eval(n) } catch { return undefined }
    })
  `)
  return { properties }
}
