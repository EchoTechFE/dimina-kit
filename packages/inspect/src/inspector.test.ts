import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SYNTHETIC_SID_PREFIX } from './sid-registry.js'
import { createWxmlInspector, type WxmlInspector } from './inspector.js'
import type { WxmlNode } from './types.js'

/** Minimal fake Vue instance leaf: a mounted element with no children of its own. */
function makeLeafInstance(tagName: string, props: Record<string, unknown>, el: HTMLElement) {
  return { type: { __tagName: tagName }, props, subTree: { el, children: [] } }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('createWxmlInspector', () => {
  let inspector: WxmlInspector

  beforeEach(() => {
    inspector = createWxmlInspector({ document })
  })

  afterEach(() => {
    inspector.dispose()
    delete (document.body as unknown as Record<string, unknown>).__vue_app__
    document.body.innerHTML = ''
  })

  describe('getWxml', () => {
    it('returns null when body has no mounted Vue app', () => {
      expect(inspector.getWxml()).toBeNull()
    })

    it('walks _instance into a WxmlNode tree with synthetic sids on nodes and their children', () => {
      // Mounted-DOM fixture: the sid registry deliberately refuses to resolve
      // disconnected elements, and a walked Vue subtree is always mounted.
      const rootEl = document.createElement('div')
      const childEl = document.createElement('span')
      rootEl.appendChild(childEl)
      document.body.appendChild(rootEl)
      const child = makeLeafInstance('text', {}, childEl)
      const root = {
        type: { __tagName: 'view' },
        props: { class: 'user-cls' },
        subTree: { el: rootEl, children: [{ component: child }] },
      }
      ;(document.body as unknown as Record<string, unknown>).__vue_app__ = { _instance: root }

      const tree = inspector.getWxml()

      expect(tree?.tagName).toBe('view')
      expect(tree?.attrs).toEqual({ class: 'user-cls' })
      expect(tree?.sid).toMatch(new RegExp(`^${SYNTHETIC_SID_PREFIX}`))
      expect(tree?.children).toHaveLength(1)
      expect(tree?.children[0]).toMatchObject({ tagName: 'text', attrs: {}, children: [] })
      expect(tree?.children[0]?.sid).toMatch(new RegExp(`^${SYNTHETIC_SID_PREFIX}`))
      // The minted sids must round-trip back to the exact elements they came from.
      expect(inspector.elementFor(tree!.sid!)).toBe(rootEl)
      expect(inspector.elementFor(tree!.children[0]!.sid!)).toBe(childEl)
    })

    it('uses an element pre-existing data-sid attribute instead of minting a synthetic one', () => {
      const el = document.createElement('div')
      el.setAttribute('data-sid', 'real-sid-7')
      const root = makeLeafInstance('view', {}, el)
      ;(document.body as unknown as Record<string, unknown>).__vue_app__ = { _instance: root }

      expect(inspector.getWxml()?.sid).toBe('real-sid-7')
    })

    it('falls back to _container._vnode.component when _instance is absent', () => {
      const el = document.createElement('div')
      const inst = makeLeafInstance('view', {}, el)
      ;(document.body as unknown as Record<string, unknown>).__vue_app__ = {
        _container: { _vnode: { component: inst } },
      }

      expect(inspector.getWxml()?.tagName).toBe('view')
    })

    it('wraps a multi-root walk result in a synthetic #fragment node', () => {
      const elA = document.createElement('div')
      const elB = document.createElement('div')
      const childA = makeLeafInstance('view', {}, elA)
      const childB = makeLeafInstance('text', {}, elB)
      // A nameless top-level instance (no `type`) is transparent, so walking it
      // surfaces its two component children as separate roots.
      const root = { subTree: { children: [{ component: childA }, { component: childB }] } }
      ;(document.body as unknown as Record<string, unknown>).__vue_app__ = { _instance: root }

      const tree = inspector.getWxml()

      expect(tree?.tagName).toBe('#fragment')
      expect(tree?.children).toHaveLength(2)
      expect(tree?.children.map((c: WxmlNode) => c.tagName)).toEqual(['view', 'text'])
    })

    it('returns null when the walked tree has no content', () => {
      const root = { subTree: { children: [] } }
      ;(document.body as unknown as Record<string, unknown>).__vue_app__ = { _instance: root }

      expect(inspector.getWxml()).toBeNull()
    })

    it('defaults to globalThis.document when no document option is given', () => {
      const defaultInspector = createWxmlInspector()
      expect(() => defaultInspector.getWxml()).not.toThrow()
      defaultInspector.dispose()
    })
  })

  describe('highlightElement', () => {
    it('measures rect and the requested style subset without mutating the element', () => {
      const el = document.createElement('div')
      el.setAttribute('data-sid', 'measured-1')
      el.style.display = 'flex'
      el.style.position = 'absolute'
      el.style.boxSizing = 'border-box'
      el.style.margin = '4px'
      el.style.padding = '2px'
      el.style.color = 'rgb(255, 0, 0)'
      el.style.backgroundColor = 'rgb(0, 0, 255)'
      el.style.fontSize = '16px'
      document.body.appendChild(el)

      const fakeRect = { x: 10, y: 20, width: 100, height: 50, top: 20, left: 10, right: 110, bottom: 70, toJSON() {} }
      el.getBoundingClientRect = vi.fn(() => fakeRect as unknown as DOMRect)

      const beforeHtml = document.body.innerHTML

      const inspection = inspector.highlightElement('measured-1')

      expect(inspection?.sid).toBe('measured-1')
      expect(inspection?.rect).toEqual({ x: 10, y: 20, width: 100, height: 50 })
      expect(inspection?.style).toEqual({
        display: 'flex',
        position: 'absolute',
        boxSizing: 'border-box',
        margin: '4px',
        padding: '2px',
        color: 'rgb(255, 0, 0)',
        backgroundColor: 'rgb(0, 0, 255)',
        fontSize: '16px',
      })
      // A measurement must be read-only: no attribute/overlay side effects.
      expect(document.body.innerHTML).toBe(beforeHtml)
      expect(document.body.children).toHaveLength(1)
    })

    it('returns null for an sid with no matching element', () => {
      expect(inspector.highlightElement('does-not-exist')).toBeNull()
    })
  })

  describe('elementFor', () => {
    it('resolves a data-sid attribute to its live element', () => {
      const el = document.createElement('div')
      el.setAttribute('data-sid', 'find-me')
      document.body.appendChild(el)

      expect(inspector.elementFor('find-me')).toBe(el)
    })

    it('returns null for an sid with no registered or matching element', () => {
      expect(inspector.elementFor('nope')).toBeNull()
    })
  })

  describe('setObserving', () => {
    it('merges a burst of DOM mutations into a single debounced callback', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const onMutated = vi.fn()
      const observing = createWxmlInspector({ document, onMutated, debounceMs: 20 })

      observing.setObserving(true)
      container.setAttribute('data-x', '1')
      container.setAttribute('data-x', '2')
      container.appendChild(document.createElement('span'))

      await wait(80)

      expect(onMutated).toHaveBeenCalledTimes(1)
      observing.dispose()
    })

    it('does not call back before observing has been turned on', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const onMutated = vi.fn()
      const observing = createWxmlInspector({ document, onMutated, debounceMs: 20 })

      container.setAttribute('data-x', '1')
      await wait(80)

      expect(onMutated).not.toHaveBeenCalled()
      observing.dispose()
    })

    it('stops delivering callbacks once observing is turned off', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const onMutated = vi.fn()
      const observing = createWxmlInspector({ document, onMutated, debounceMs: 20 })

      observing.setObserving(true)
      observing.setObserving(false)
      container.setAttribute('data-x', '1')
      await wait(80)

      expect(onMutated).not.toHaveBeenCalled()
      observing.dispose()
    })

    it('cancels a debounced callback already pending when observing turns off before it fires', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const onMutated = vi.fn()
      const observing = createWxmlInspector({ document, onMutated, debounceMs: 30 })

      observing.setObserving(true)
      container.setAttribute('data-x', '1')
      await wait(5) // mutation observed and debounce timer armed, well short of debounceMs
      observing.setObserving(false)
      await wait(80)

      expect(onMutated).not.toHaveBeenCalled()
      observing.dispose()
    })

    it('does not double the callback when turned on twice in a row', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const onMutated = vi.fn()
      const observing = createWxmlInspector({ document, onMutated, debounceMs: 20 })

      observing.setObserving(true)
      observing.setObserving(true)
      container.setAttribute('data-x', '1')
      await wait(80)

      expect(onMutated).toHaveBeenCalledTimes(1)
      observing.dispose()
    })

    it('resumes observing after being turned off and back on', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const onMutated = vi.fn()
      const observing = createWxmlInspector({ document, onMutated, debounceMs: 20 })

      observing.setObserving(true)
      observing.setObserving(false)
      observing.setObserving(true)
      container.setAttribute('data-x', '1')
      await wait(80)

      expect(onMutated).toHaveBeenCalledTimes(1)
      observing.dispose()
    })
  })

  describe('dispose', () => {
    it('produces no further callbacks after dispose, even for mutations already pending', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const onMutated = vi.fn()
      const observing = createWxmlInspector({ document, onMutated, debounceMs: 20 })

      observing.setObserving(true)
      container.setAttribute('data-x', '1')
      observing.dispose()
      await wait(80)

      expect(onMutated).not.toHaveBeenCalled()
    })

    it('is safe to call before observing was ever turned on', () => {
      const observing = createWxmlInspector({ document })
      expect(() => observing.dispose()).not.toThrow()
    })
  })
})
