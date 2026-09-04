import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  ipcRenderer: {
    send: vi.fn(),
  },
}))

vi.mock('@dimina-kit/view-anchor', () => ({
  createSizeAdvertiser: vi.fn(() => ({ dispose: vi.fn() })),
}))

import { createSizeAdvertiser } from '@dimina-kit/view-anchor'
import { installHostSidebarAdvertiserWhenReady } from './host-sidebar-advertiser.js'

const mockedCreateSizeAdvertiser = vi.mocked(createSizeAdvertiser)

/** Overrides the (normally read-only) `document.readyState` for a single test. */
function setReadyState(value: DocumentReadyState) {
  Object.defineProperty(document, 'readyState', {
    value,
    configurable: true,
  })
}

function mountSidebarRoot(): HTMLElement {
  const root = document.createElement('div')
  root.setAttribute('data-host-sidebar-root', '')
  document.body.appendChild(root)
  return root
}

describe('installHostSidebarAdvertiserWhenReady', () => {
  const originalReadyState = document.readyState

  beforeEach(() => {
    vi.clearAllMocks()
    // Host-loaded sidebar content: the document the warning is written for.
    // jsdom's own document is `about:blank`, which the runtime treats as the
    // view's un-navigated document and deliberately never warns about.
    vi.stubGlobal('location', { href: 'file:///sidebar-content.html' })
  })

  afterEach(() => {
    document.body.replaceChildren()
    setReadyState(originalReadyState)
    vi.unstubAllGlobals()
  })

  // Reproduces the real production race: the React sidebar app (see
  // host-sidebar-default.tsx) mounts its `[data-host-sidebar-root]` element
  // asynchronously, after DOMContentLoaded has already fired. A one-shot
  // query at DOMContentLoaded time is too early and must not be the only
  // chance to find the root.
  it('advertises once the sidebar root mounts asynchronously after DOMContentLoaded', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setReadyState('loading')
    installHostSidebarAdvertiserWhenReady()

    document.dispatchEvent(new Event('DOMContentLoaded'))

    // Root does not exist yet at DOMContentLoaded time — mimics React
    // mounting on a later microtask, not synchronously during parsing.
    await Promise.resolve()
    const root = mountSidebarRoot()

    // Give a MutationObserver-driven watcher a chance to react; no fixed
    // delay is assumed to be required.
    await Promise.resolve()
    await Promise.resolve()

    expect(mockedCreateSizeAdvertiser).toHaveBeenCalledTimes(1)
    expect(mockedCreateSizeAdvertiser).toHaveBeenCalledWith(
      root,
      expect.objectContaining({ axis: 'inline' }),
    )

    // This is the healthy path for every framework-rendered slot content,
    // devtools' own rail included — it must stay silent, or the warning that
    // exists for a genuinely missing root becomes startup noise.
    setReadyState('complete')
    window.dispatchEvent(new Event('load'))
    expect(warnSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it('advertises immediately when the sidebar root already exists before DOMContentLoaded', () => {
    const root = mountSidebarRoot()

    setReadyState('loading')
    installHostSidebarAdvertiserWhenReady()
    document.dispatchEvent(new Event('DOMContentLoaded'))

    expect(mockedCreateSizeAdvertiser).toHaveBeenCalledTimes(1)
    expect(mockedCreateSizeAdvertiser).toHaveBeenCalledWith(
      root,
      expect.objectContaining({ axis: 'inline' }),
    )
  })

  // The sidebar WCV holds an empty document until the host loads content into
  // it, and this preload runs there too. Nobody authored that document, so a
  // missing root there is not an authoring mistake — warning about it prints
  // on every single app start.
  it('stays silent on the view\'s own blank document, which carries no slot content', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('location', { href: 'about:blank' })

    setReadyState('complete')
    installHostSidebarAdvertiserWhenReady()
    window.dispatchEvent(new Event('load'))

    expect(mockedCreateSizeAdvertiser).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  // A concurrent React root commits its first render on a scheduler task that
  // can land after `load`; the verdict has to wait for the main thread to run
  // out of that work, or the healthy mount races the warning.
  it('stays silent when the root mounts after load but before the main thread goes idle', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const idleCallbacks: Array<() => void> = []
    vi.stubGlobal('requestIdleCallback', (cb: () => void) => { idleCallbacks.push(cb); return 1 })

    setReadyState('loading')
    installHostSidebarAdvertiserWhenReady()
    document.dispatchEvent(new Event('DOMContentLoaded'))

    setReadyState('complete')
    window.dispatchEvent(new Event('load'))
    expect(warnSpy).not.toHaveBeenCalled()

    // The framework's own commit lands between load and the idle verdict.
    const root = mountSidebarRoot()
    for (const cb of idleCallbacks) cb()
    expect(warnSpy).not.toHaveBeenCalled()

    // The observer delivers on a microtask, after the idle verdict above.
    await Promise.resolve()
    await Promise.resolve()
    expect(mockedCreateSizeAdvertiser).toHaveBeenCalledWith(
      root,
      expect.objectContaining({ axis: 'inline' }),
    )

    warnSpy.mockRestore()
  })

  it('warns and does not install when the sidebar root never appears', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    setReadyState('loading')
    expect(() => {
      installHostSidebarAdvertiserWhenReady()
      document.dispatchEvent(new Event('DOMContentLoaded'))
    }).not.toThrow()

    expect(mockedCreateSizeAdvertiser).not.toHaveBeenCalled()

    // Still silent here: at DOMContentLoaded a missing root is indistinguishable
    // from one that a framework has not mounted yet.
    expect(warnSpy).not.toHaveBeenCalled()

    // Once the document has finished loading with the root still absent, the
    // content genuinely lacks it and the author needs to hear about it.
    setReadyState('complete')
    window.dispatchEvent(new Event('load'))
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })
})
