import type { Handler } from '../shared.js'
import { buildElAccess, evalInSim, inIframe } from '../exec.js'
import { getElementRef, registerElement } from '../registry.js'

export const elementHandlers: Record<string, Handler> = {}

// -- Element domain --

elementHandlers['Element.tap'] = async (ctx, params) => {
  const ref = getElementRef(params)
  await evalInSim(ctx, inIframe(`
    ${buildElAccess(ref)}
    if (!el) throw new Error('Element not found')
    el.click()
  `))
  return {}
}

elementHandlers['Element.triggerEvent'] = async (ctx, params) => {
  const ref = getElementRef(params)
  const type = params.type as string
  const detail = params.detail || {}
  await evalInSim(ctx, inIframe(`
    ${buildElAccess(ref)}
    if (!el) throw new Error('Element not found')
    el.dispatchEvent(new CustomEvent('${type}', { detail: ${JSON.stringify(detail)}, bubbles: true }))
  `))
  return {}
}

elementHandlers['Element.touchstart'] = async (ctx, params) => {
  const ref = getElementRef(params)
  await evalInSim(ctx, inIframe(`
    ${buildElAccess(ref)}
    if (el) el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true }))
  `))
  return {}
}

elementHandlers['Element.touchmove'] = async (ctx, params) => {
  const ref = getElementRef(params)
  await evalInSim(ctx, inIframe(`
    ${buildElAccess(ref)}
    if (el) el.dispatchEvent(new TouchEvent('touchmove', { bubbles: true }))
  `))
  return {}
}

elementHandlers['Element.touchend'] = async (ctx, params) => {
  const ref = getElementRef(params)
  await evalInSim(ctx, inIframe(`
    ${buildElAccess(ref)}
    if (el) el.dispatchEvent(new TouchEvent('touchend', { bubbles: true }))
  `))
  return {}
}

elementHandlers['Element.getDOMProperties'] = async (ctx, params) => {
  const ref = getElementRef(params)
  const names = params.names as string[]
  const properties = await evalInSim<unknown[]>(ctx, inIframe(`
    ${buildElAccess(ref)}
    if (!el) return ${JSON.stringify(names.map(() => null))}
    return ${JSON.stringify(names)}.map(n => el[n])
  `))
  return { properties }
}

elementHandlers['Element.getAttributes'] = async (ctx, params) => {
  const ref = getElementRef(params)
  const names = params.names as string[]
  const attributes = await evalInSim<(string | null)[]>(ctx, inIframe(`
    ${buildElAccess(ref)}
    if (!el) return ${JSON.stringify(names.map(() => null))}
    return ${JSON.stringify(names)}.map(n => el.getAttribute(n))
  `))
  return { attributes }
}

elementHandlers['Element.getStyles'] = async (ctx, params) => {
  const ref = getElementRef(params)
  const names = params.names as string[]
  const styles = await evalInSim<string[]>(ctx, inIframe(`
    ${buildElAccess(ref)}
    if (!el) return ${JSON.stringify(names.map(() => ''))}
    const cs = getComputedStyle(el)
    return ${JSON.stringify(names)}.map(n => cs.getPropertyValue(n))
  `))
  return { styles }
}

elementHandlers['Element.getWXML'] = async (ctx, params) => {
  const ref = getElementRef(params)
  const type = (params.type as string) || 'inner'
  const prop = type === 'outer' ? 'outerHTML' : 'innerHTML'
  const wxml = await evalInSim<string>(ctx, inIframe(`
    ${buildElAccess(ref)}
    return el ? el.${prop} : ''
  `))
  return { wxml }
}

elementHandlers['Element.getOffset'] = async (ctx, params) => {
  const ref = getElementRef(params)
  return evalInSim(ctx, inIframe(`
    ${buildElAccess(ref)}
    if (!el) return { left: 0, top: 0 }
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top }
  `))
}

elementHandlers['Element.getElement'] = async (ctx, params) => {
  const parentRef = getElementRef(params)
  const selector = params.selector as string
  const escaped = selector.replace(/'/g, "\\'")

  const info = await evalInSim<{ tagName: string } | null>(ctx, inIframe(`
    ${buildElAccess(parentRef, 'parent')}
    if (!parent) return null
    const child = parent.querySelector('${escaped}')
    if (!child) return null
    return { tagName: child.tagName.toLowerCase() }
  `))

  if (!info) throw new Error(`Child element not found: ${selector}`)
  const combinedSelector = `${parentRef.selector} ${selector}`
  const elementId = registerElement(combinedSelector, 0, parentRef.pageId)
  return { elementId, tagName: info.tagName }
}

elementHandlers['Element.getElements'] = async (ctx, params) => {
  const parentRef = getElementRef(params)
  const selector = params.selector as string
  const escaped = selector.replace(/'/g, "\\'")

  const items = await evalInSim<Array<{ tagName: string }>>(ctx, inIframe(`
    ${buildElAccess(parentRef, 'parent')}
    if (!parent) return []
    return Array.from(parent.querySelectorAll('${escaped}')).map(el => ({
      tagName: el.tagName.toLowerCase(),
    }))
  `))

  const combinedSelector = `${parentRef.selector} ${selector}`
  return {
    elements: items.map((item, i) => ({
      elementId: registerElement(combinedSelector, i, parentRef.pageId),
      tagName: item.tagName,
    })),
  }
}

elementHandlers['Element.getProperties'] = async (ctx, params) => {
  // Fall back to DOM properties
  return elementHandlers['Element.getDOMProperties']!(ctx, params)
}

elementHandlers['Element.setData'] = async () => {
  throw new Error('Element.setData (component) is not supported')
}
elementHandlers['Element.getData'] = async () => {
  throw new Error('Element.getData (component) is not supported')
}
elementHandlers['Element.callMethod'] = async () => {
  throw new Error('Element.callMethod (component) is not supported')
}
elementHandlers['Element.callFunction'] = async () => {
  throw new Error('Element.callFunction is not supported')
}
