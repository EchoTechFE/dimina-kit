import type { Handler } from '../shared.js'
import { evalInElement } from '../exec.js'
import { getElementRef, registerElement } from '../registry.js'

export const elementHandlers: Record<string, Handler> = {}

// -- Element domain --

elementHandlers['Element.tap'] = async (ctx, params) => {
  const ref = getElementRef(params)
  await evalInElement(ctx, ref, `
    if (!el) throw new Error('Element not found')
    el.click()
  `)
  return {}
}

elementHandlers['Element.triggerEvent'] = async (ctx, params) => {
  const ref = getElementRef(params)
  const type = params.type as string
  const detail = params.detail || {}
  await evalInElement(ctx, ref, `
    if (!el) throw new Error('Element not found')
    el.dispatchEvent(new CustomEvent('${type}', { detail: ${JSON.stringify(detail)}, bubbles: true }))
  `)
  return {}
}

interface TouchPoint {
  identifier?: number
  pageX?: number
  pageY?: number
  clientX?: number
  clientY?: number
}

/**
 * Touch events must carry real touch points: the gesture layer reads coordinates
 * off `touches` / `changedTouches` to decide tap vs. move-cancel, so an event with
 * empty lists reaches it as a touch that happened nowhere. The protocol lets the
 * caller omit points entirely (`touchstart()` with no args), in which case the
 * element's centre — read from live layout, not a fixed offset — stands in for
 * where a finger would land.
 */
function touchHandler(type: 'touchstart' | 'touchmove' | 'touchend'): Handler {
  // A finished touch is no longer among the active `touches`, only in `changedTouches`.
  const fallbackTouches = type === 'touchend' ? '[]' : '[{}]'
  return async (ctx, params) => {
    const ref = getElementRef(params)
    const touches = (params.touches as TouchPoint[] | undefined) ?? null
    // The protocol spells it `changeTouches`; the DOM event field is `changedTouches`.
    const changed = (params.changeTouches as TouchPoint[] | undefined) ?? null
    await evalInElement(ctx, ref, `
      if (!el) throw new Error('Element not found')
      const rect = el.getBoundingClientRect()
      const centreX = rect.left + rect.width / 2
      const centreY = rect.top + rect.height / 2
      const make = (p, i) => {
        const clientX = p.clientX != null ? p.clientX : (p.pageX != null ? p.pageX - scrollX : centreX)
        const clientY = p.clientY != null ? p.clientY : (p.pageY != null ? p.pageY - scrollY : centreY)
        return new Touch({
          identifier: p.identifier != null ? p.identifier : i,
          target: el,
          clientX,
          clientY,
          pageX: p.pageX != null ? p.pageX : clientX + scrollX,
          pageY: p.pageY != null ? p.pageY : clientY + scrollY,
          screenX: clientX,
          screenY: clientY,
          force: 1,
        })
      }
      const raw = ${JSON.stringify(touches)}
      const rawChanged = ${JSON.stringify(changed)}
      const active = (raw || ${fallbackTouches}).map(make)
      const changedList = (rawChanged || raw || [{}]).map(make)
      el.dispatchEvent(new TouchEvent('${type}', {
        bubbles: true,
        cancelable: true,
        composed: true,
        touches: active,
        targetTouches: active,
        changedTouches: changedList,
      }))
    `)
    return {}
  }
}

elementHandlers['Element.touchstart'] = touchHandler('touchstart')
elementHandlers['Element.touchmove'] = touchHandler('touchmove')
elementHandlers['Element.touchend'] = touchHandler('touchend')

elementHandlers['Element.getDOMProperties'] = async (ctx, params) => {
  const ref = getElementRef(params)
  const names = params.names as string[]
  const properties = await evalInElement<unknown[]>(ctx, ref, `
    if (!el) return ${JSON.stringify(names.map(() => null))}
    return ${JSON.stringify(names)}.map(n => el[n])
  `)
  return { properties }
}

elementHandlers['Element.getAttributes'] = async (ctx, params) => {
  const ref = getElementRef(params)
  const names = params.names as string[]
  const attributes = await evalInElement<(string | null)[]>(ctx, ref, `
    if (!el) return ${JSON.stringify(names.map(() => null))}
    return ${JSON.stringify(names)}.map(n => el.getAttribute(n))
  `)
  return { attributes }
}

elementHandlers['Element.getStyles'] = async (ctx, params) => {
  const ref = getElementRef(params)
  const names = params.names as string[]
  const styles = await evalInElement<string[]>(ctx, ref, `
    if (!el) return ${JSON.stringify(names.map(() => ''))}
    const cs = getComputedStyle(el)
    return ${JSON.stringify(names)}.map(n => cs.getPropertyValue(n))
  `)
  return { styles }
}

elementHandlers['Element.getWXML'] = async (ctx, params) => {
  const ref = getElementRef(params)
  const type = (params.type as string) || 'inner'
  const prop = type === 'outer' ? 'outerHTML' : 'innerHTML'
  const wxml = await evalInElement<string>(ctx, ref, `
    return el ? el.${prop} : ''
  `)
  return { wxml }
}

elementHandlers['Element.getOffset'] = async (ctx, params) => {
  const ref = getElementRef(params)
  return evalInElement(ctx, ref, `
    if (!el) return { left: 0, top: 0 }
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top }
  `)
}

elementHandlers['Element.getElement'] = async (ctx, params) => {
  const parentRef = getElementRef(params)
  const selector = params.selector as string

  const info = await evalInElement<{ tagName: string } | null>(ctx, parentRef, `
    if (!parent) return null
    const child = parent.querySelector(${JSON.stringify(selector)})
    if (!child) return null
    return { tagName: child.tagName.toLowerCase() }
  `, 'parent')

  if (!info) throw new Error(`Child element not found: ${selector}`)
  const combinedSelector = `${parentRef.selector} ${selector}`
  const elementId = registerElement(combinedSelector, 0, parentRef.pageId)
  return { elementId, tagName: info.tagName }
}

elementHandlers['Element.getElements'] = async (ctx, params) => {
  const parentRef = getElementRef(params)
  const selector = params.selector as string

  const items = await evalInElement<Array<{ tagName: string }>>(ctx, parentRef, `
    if (!parent) return []
    return Array.from(parent.querySelectorAll(${JSON.stringify(selector)})).map(el => ({
      tagName: el.tagName.toLowerCase(),
    }))
  `, 'parent')

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
