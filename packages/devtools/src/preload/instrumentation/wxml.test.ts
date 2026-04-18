import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SimulatorChannel } from '../../shared/ipc-channels.js'

vi.mock('electron', () => ({
  ipcRenderer: {
    sendToHost: vi.fn(),
    on: vi.fn(),
  },
}))

import { ipcRenderer } from 'electron'
import { sendWxmlTree, setupWxmlObserver } from './wxml'

let disposeObserver: (() => void) | null = null

/** Helper: build a minimal mock Vue component instance tree. */
function makeInstance(
  tagName: string,
  props: Record<string, unknown> = {},
  children: Record<string, unknown>[] = [],
) {
  return {
    type: { __tagName: tagName },
    props,
    subTree: {
      children: children.map((child) => ({ component: child })),
    },
  }
}

/**
 * Create a mock iframe with class "dimina-native-webview__window"
 * and mount a Vue app instance on its contentDocument.body.
 */
function createMockIframe(instance?: Record<string, unknown>): HTMLIFrameElement {
  const iframe = document.createElement('iframe')
  iframe.className = 'dimina-native-webview__window'
  document.body.appendChild(iframe)

  if (instance) {
    mountVueAppOnIframe(iframe, instance)
  }
  return iframe
}

function mountVueAppOnIframe(
  iframe: HTMLIFrameElement,
  instance: Record<string, unknown>,
) {
  const doc = iframe.contentDocument!
  Object.defineProperty(doc.body, '__vue_app__', {
    value: { _instance: instance },
    configurable: true,
    writable: true,
  })
}

function cleanupIframes() {
  document.querySelectorAll('.dimina-native-webview__window').forEach((el) => el.remove())
}

describe('sendWxmlTree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanupIframes()
  })

  it('does nothing when no iframe exists', () => {
    sendWxmlTree()
    expect(ipcRenderer.sendToHost).not.toHaveBeenCalled()
  })

  it('does nothing when iframe has no __vue_app__', () => {
    createMockIframe() // no instance
    sendWxmlTree()
    expect(ipcRenderer.sendToHost).not.toHaveBeenCalled()
  })

  it('sends a simple single-node tree', () => {
    const instance = makeInstance('view', { class: 'container' })
    createMockIframe(instance)

    sendWxmlTree()

    expect(ipcRenderer.sendToHost).toHaveBeenCalledWith(
      SimulatorChannel.Wxml,
      expect.objectContaining({
        tagName: 'view',
        attrs: { class: 'container' },
        children: [],
      }),
    )
  })

  it('extracts nested component children', () => {
    const child = makeInstance('text', { value: 'hello' })
    const root = makeInstance('view', {}, [child])
    createMockIframe(root)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.tagName).toBe('view')
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0].tagName).toBe('text')
  })

  it('resolves dd- prefix names correctly', () => {
    const instance = {
      type: { __name: 'dd-button' },
      props: {},
      subTree: { children: [] },
    }
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.tagName).toBe('button')
  })

  it('resolves dd-page to page', () => {
    const instance = {
      type: { name: 'dd-page' },
      props: {},
      subTree: { children: [] },
    }
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.tagName).toBe('page')
  })

  it('resolves CamelCase DdButton to button', () => {
    const instance = {
      type: { name: 'DdButton' },
      props: {},
      subTree: { children: [] },
    }
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.tagName).toBe('button')
  })

  it('filters out function and undefined props', () => {
    const instance = makeInstance('view', {
      visible: true,
      onClick: () => {},
      missing: undefined,
      title: 'hi',
    })
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.attrs).toEqual({ visible: 'true', title: 'hi' })
  })

  it('filters out data and __-prefixed props', () => {
    const instance = makeInstance('view', {
      data: { complex: true },
      __internal: 'hidden',
      label: 'show',
    })
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.attrs).toEqual({ label: 'show' })
  })

  it('filters out false boolean props', () => {
    const instance = makeInstance('view', { disabled: false, enabled: true })
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.attrs).toEqual({ enabled: 'true' })
  })

  it('extracts text VNode children', () => {
    const instance = {
      type: { __tagName: 'text' },
      props: {},
      subTree: {
        children: 'Hello World',
        type: Symbol('Text'),
      },
    }
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    // The text is extracted as a child text node
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0].tagName).toBe('#text')
    expect(tree.children[0].text).toBe('Hello World')
  })

  it('handles fragment VNodes (symbol type) by recursing into children', () => {
    const innerChild = makeInstance('button', { type: 'primary' })
    const instance = {
      type: { __tagName: 'view' },
      props: {},
      subTree: {
        children: [
          {
            type: Symbol('Fragment'),
            children: [{ component: innerChild }],
          },
        ],
      },
    }
    createMockIframe(instance)

    sendWxmlTree()

    const tree = (ipcRenderer.sendToHost as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0].tagName).toBe('button')
  })
})

describe('setupWxmlObserver', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    disposeObserver = null
  })

  afterEach(() => {
    disposeObserver?.()
    cleanupIframes()
    vi.useRealTimers()
  })

  it('sends tree immediately when iframe with app is already present', () => {
    const instance = makeInstance('page')
    createMockIframe(instance)

    disposeObserver = setupWxmlObserver()

    expect(ipcRenderer.sendToHost).toHaveBeenCalledWith(
      SimulatorChannel.Wxml,
      expect.objectContaining({ tagName: 'page' }),
    )
  })

  it('retries via interval when iframe is not yet present', () => {
    disposeObserver = setupWxmlObserver()
    expect(ipcRenderer.sendToHost).not.toHaveBeenCalled()

    // Add iframe with Vue app and advance past the 500ms interval
    const instance = makeInstance('page')
    createMockIframe(instance)
    vi.advanceTimersByTime(500)

    expect(ipcRenderer.sendToHost).toHaveBeenCalledWith(
      SimulatorChannel.Wxml,
      expect.objectContaining({ tagName: 'page' }),
    )
  })
})
