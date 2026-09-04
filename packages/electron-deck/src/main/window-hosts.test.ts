/**
 * Behavior tests for `windowHostsWebContents` in `./window-hosts.ts`.
 *
 * The function must judge ownership across every shape a simulator/render
 * surface can take: the window's own renderer, a `WebContentsView` nested at
 * any depth in `contentView`, and a `<webview>` guest (reported via
 * `hostWebContents`, itself possibly a nested view). Fakes below model only
 * the fields the function reads (`id`, `isDestroyed()`, `webContents`,
 * `children`, `hostWebContents`) — no Electron import.
 */
import { describe, it, expect } from 'vitest'
import { windowHostsWebContents } from './window-hosts.js'

interface FakeWebContents {
  id: number
  isDestroyed: () => boolean
  hostWebContents?: FakeWebContents
}

interface FakeView {
  webContents?: FakeWebContents
  children?: FakeView[]
}

interface FakeWindow {
  webContents?: FakeWebContents
  contentView?: FakeView
  isDestroyed: () => boolean
}

let nextId = 1
function wc(opts: { destroyed?: boolean; hostWebContents?: FakeWebContents } = {}): FakeWebContents {
  const id = nextId++
  return {
    id,
    isDestroyed: () => opts.destroyed ?? false,
    hostWebContents: opts.hostWebContents,
  }
}

function view(webContents: FakeWebContents | undefined, children: FakeView[] = []): FakeView {
  return { webContents, children }
}

function win(opts: { rendererDestroyed?: boolean; windowDestroyed?: boolean; contentView?: FakeView } = {}): {
  window: FakeWindow
  renderer: FakeWebContents
} {
  const renderer = wc({ destroyed: opts.rendererDestroyed })
  return {
    window: {
      webContents: renderer,
      contentView: opts.contentView,
      isDestroyed: () => opts.windowDestroyed ?? false,
    },
    renderer,
  }
}

describe('windowHostsWebContents — direct membership', () => {
  it('the window\'s own renderer webContents belongs to that window', () => {
    const { window, renderer } = win()
    expect(windowHostsWebContents(window as never, renderer as never)).toBe(true)
  })

  it('a WebContentsView mounted directly in contentView belongs to the window', () => {
    const paneWc = wc()
    const { window } = win({ contentView: view(undefined, [view(paneWc)]) })
    expect(windowHostsWebContents(window as never, paneWc as never)).toBe(true)
  })

  it('a WebContentsView nested several levels deep still belongs to the window', () => {
    const deepWc = wc()
    const tree = view(undefined, [view(undefined, [view(undefined, [view(deepWc)])])])
    const { window } = win({ contentView: tree })
    expect(windowHostsWebContents(window as never, deepWc as never)).toBe(true)
  })

  it('an unrelated window\'s webContents does not belong', () => {
    const { window: windowA } = win()
    const { renderer: rendererB } = win()
    expect(windowHostsWebContents(windowA as never, rendererB as never)).toBe(false)
  })

  it('an unrelated webContents not present anywhere in contentView does not belong', () => {
    const paneWc = wc()
    const strangerWc = wc()
    const { window } = win({ contentView: view(undefined, [view(paneWc)]) })
    expect(windowHostsWebContents(window as never, strangerWc as never)).toBe(false)
  })
})

describe('windowHostsWebContents — <webview> guest via hostWebContents', () => {
  it('a guest whose host is the window\'s own renderer belongs to that window', () => {
    const { window, renderer } = win()
    const guest = wc({ hostWebContents: renderer })
    expect(windowHostsWebContents(window as never, guest as never)).toBe(true)
  })

  it('a guest whose host is a nested WebContentsView belongs to that window', () => {
    const paneWc = wc()
    const { window } = win({ contentView: view(undefined, [view(paneWc)]) })
    const guest = wc({ hostWebContents: paneWc })
    expect(windowHostsWebContents(window as never, guest as never)).toBe(true)
  })

  it('a guest whose host belongs to a DIFFERENT window does not belong', () => {
    const { window: windowA } = win()
    const { renderer: rendererB } = win()
    const guest = wc({ hostWebContents: rendererB })
    expect(windowHostsWebContents(windowA as never, guest as never)).toBe(false)
  })
})

describe('windowHostsWebContents — destroyed / missing inputs', () => {
  it('an undefined window never hosts anything', () => {
    const someWc = wc()
    expect(windowHostsWebContents(undefined, someWc as never)).toBe(false)
  })

  it('a destroyed window never hosts anything, even its own former renderer', () => {
    const { window, renderer } = win({ windowDestroyed: true })
    expect(windowHostsWebContents(window as never, renderer as never)).toBe(false)
  })

  it('a destroyed target webContents is never judged as hosted', () => {
    const { window, renderer } = win()
    renderer.isDestroyed = () => true
    expect(windowHostsWebContents(window as never, renderer as never)).toBe(false)
  })

  it('a destroyed renderer is skipped for direct membership, but nested views are still checked', () => {
    const paneWc = wc()
    const { window } = win({ rendererDestroyed: true, contentView: view(undefined, [view(paneWc)]) })
    expect(windowHostsWebContents(window as never, paneWc as never)).toBe(true)
  })

  it('a destroyed view in the contentView tree is not matched even if its id would otherwise equal the target', () => {
    const paneWc = wc({ destroyed: true })
    const { window } = win({ contentView: view(undefined, [view(paneWc)]) })
    // The target itself passed to the function is live; only the TREE's copy
    // is destroyed, modeling a stale/torn-down view still linked in the tree.
    const liveSameId: FakeWebContents = { id: paneWc.id, isDestroyed: () => false }
    expect(windowHostsWebContents(window as never, liveSameId as never)).toBe(false)
  })

  it('a destroyed host behind a <webview> guest is not honored', () => {
    const { window, renderer } = win()
    renderer.isDestroyed = () => true
    const guest = wc({ hostWebContents: renderer })
    expect(windowHostsWebContents(window as never, guest as never)).toBe(false)
  })
})
