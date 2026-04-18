import type { Handler } from '../shared.js'
import { evalInSim, inIframe } from '../exec.js'
import { registerElement } from '../registry.js'

export const pageHandlers: Record<string, Handler> = {}

// -- Page domain --

pageHandlers['Page.getElement'] = async (ctx, params) => {
  const selector = params.selector as string
  const pageId = (params.pageId as number) || 1
  const escaped = selector.replace(/'/g, "\\'")

  const info = await evalInSim<{ tagName: string } | null>(ctx, inIframe(`
    const el = _doc.querySelector('${escaped}')
    if (!el) return null
    return { tagName: el.tagName.toLowerCase() }
  `))

  if (!info) throw new Error(`Element not found: ${selector}`)
  const elementId = registerElement(selector, 0, pageId)
  return { elementId, tagName: info.tagName }
}

pageHandlers['Page.getElements'] = async (ctx, params) => {
  const selector = params.selector as string
  const pageId = (params.pageId as number) || 1
  const escaped = selector.replace(/'/g, "\\'")

  const items = await evalInSim<Array<{ tagName: string }>>(ctx, inIframe(`
    return Array.from(_doc.querySelectorAll('${escaped}')).map(el => ({
      tagName: el.tagName.toLowerCase(),
    }))
  `))

  return {
    elements: items.map((item, i) => ({
      elementId: registerElement(selector, i, pageId),
      tagName: item.tagName,
    })),
  }
}

pageHandlers['Page.getData'] = async (ctx, params) => {
  const pathKey = params.path as string | undefined
  const appdata = await evalInSim<Record<string, unknown>>(ctx,
    `window.__simulatorData ? window.__simulatorData.getAppdata() : {}`,
  )

  if (!pathKey) return { data: appdata }

  const keys = pathKey.replace(/\[(\d+)\]/g, '.$1').split('.')
  let val: unknown = appdata
  for (const k of keys) {
    if (val == null || typeof val !== 'object') { val = undefined; break }
    val = (val as Record<string, unknown>)[k]
  }
  return { data: val }
}

pageHandlers['Page.setData'] = async () => {
  throw new Error('Page.setData is not supported (requires AppService layer)')
}

pageHandlers['Page.callMethod'] = async (_ctx, params) => {
  throw new Error(`Page.callMethod('${params.method}') is not supported (requires AppService layer)`)
}

pageHandlers['Page.getWindowProperties'] = async (ctx, params) => {
  const names = params.names as string[]
  const properties = await evalInSim<unknown[]>(ctx, inIframe(`
    return ${JSON.stringify(names)}.map(n => {
      try { return eval(n) } catch { return undefined }
    })
  `))
  return { properties }
}
