/**
 * Shared fixtures for the MiniAppFrame suites: a fake host plus the probes
 * those suites read the frame's behavior through.
 *
 * The host is a ledger, not just a stub — it records every page the frame asked
 * to open, every page it asked to close and every lifecycle it pushed, in the
 * order the host received them. A suite can therefore assert both that no
 * render host is dropped from state without being torn down AND that the
 * lifecycle the service layer needs actually reached the host, not merely that
 * the reducer produced the right effect list. `calls` is the same ledger with
 * every kind interleaved, which is what an assertion about the ORDER of two
 * different calls needs. `gateOpenPage` holds `openPage` unresolved to
 * reproduce the IPC round-trip window a user can click through.
 */
import React from 'react'
import { act, render } from '@testing-library/react'
import { SIMULATOR_EVENTS as E } from '../../shared/bridge-channels.js'
import type {
  AppManifest,
  NavActionPayload,
  NavCallbackPayload,
  PageLifecycleEvent,
  PageOpenResult,
  PageStackEntry,
  PageWindowConfig,
} from '../../shared/bridge-channels.js'
import type { MiniAppHost } from '../miniapp-host.js'
import { MiniAppFrame } from '../miniapp-frame.js'

export const APP_ID = 'test-app'
export const HOME_PAGE = 'pages/home/home'
export const OTHER_TAB_PAGE = 'pages/mine/mine'
export const INNER_PAGE = 'pages/detail/detail'
/** A non-tab page whose `homeButton: true` lifts the stack-bottom requirement. */
export const FORCED_PAGE = 'pages/promo/promo'
/** The bridgeId the host hands back for the page a spawn mounts. */
export const ROOT_BRIDGE_ID = 'root-bridge'
export const APP_SESSION_ID = 'session-1'

export const MANIFEST: AppManifest = {
  entryPagePath: HOME_PAGE,
  pages: [HOME_PAGE, OTHER_TAB_PAGE, INNER_PAGE, FORCED_PAGE],
  tabBar: { list: [{ pagePath: HOME_PAGE }, { pagePath: OTHER_TAB_PAGE }] },
  source: 'app-config',
}

const WINDOW_CONFIGS: Record<string, PageWindowConfig> = {
  [FORCED_PAGE]: { homeButton: true },
}

function windowConfigFor(pagePath: string): PageWindowConfig {
  return WINDOW_CONFIGS[pagePath] ?? {}
}

type Listener = (payload: unknown) => void

export interface OpenedPage {
  pagePath: string
  bridgeId: string
}

export interface LifecycleRecord {
  bridgeId: string
  event: PageLifecycleEvent
}

/**
 * One call the frame made on the host. Relative order between two different
 * kinds of call is only assertable from a single ordered log — per-kind arrays
 * cannot express "the stack was reported before the active page was".
 */
export type HostCall =
  | { kind: 'activePage'; bridgeId: string }
  | { kind: 'pageStack'; stack: string[] }
  | { kind: 'lifecycle'; bridgeId: string; event: PageLifecycleEvent }
  | { kind: 'closePage'; bridgeId: string }
  | { kind: 'openPage'; pagePath: string; bridgeId: string }

export interface HostRecorder {
  navCallbacks: NavCallbackPayload[]
  pageStacks: Array<{ stack: PageStackEntry[] }>
  openedPages: string[]
  /** Every page the frame asked the host to open, with the bridgeId it received. */
  openedEntries: OpenedPage[]
  /** Every bridgeId the frame asked the host to tear down. */
  closedPages: string[]
  /**
   * Every lifecycle the frame pushed to the host, in arrival order. The service
   * layer only ever learns a page hid, showed or unloaded through this call, so
   * a frame that computes the right effects but never delivers them is
   * indistinguishable from a correct one without reading this ledger.
   */
  lifecycles: LifecycleRecord[]
  /** Every host call above, interleaved in the order the host received them. */
  calls: HostCall[]
  /** Pushes a main→simulator event exactly the way the preload bridge does. */
  fire(channel: string, payload: unknown): void
  /** Holds every subsequent `openPage` unresolved until the returned fn runs. */
  gateOpenPage(): () => void
}

export interface FakeHost {
  host: MiniAppHost
  recorder: HostRecorder
}

/**
 * A host that answers exactly what MANIFEST describes and logs everything the
 * frame does to it. Nothing here touches a global: the frame reaches its host
 * through the prop, so a suite can hold two independent hosts at once.
 */
export function createFakeHost(rootPagePath: string): FakeHost {
  const listeners = new Map<string, Set<Listener>>()
  let gate: Promise<void> | null = null
  const recorder: HostRecorder = {
    navCallbacks: [],
    pageStacks: [],
    openedPages: [],
    openedEntries: [],
    closedPages: [],
    lifecycles: [],
    calls: [],
    fire(channel, payload) {
      for (const fn of [...(listeners.get(channel) ?? [])]) fn(payload)
    },
    gateOpenPage() {
      let release!: () => void
      gate = new Promise<void>((resolve) => { release = resolve })
      return () => {
        gate = null
        release()
      }
    },
  }
  let nextPageId = 0
  const isTab = (pagePath: string): boolean =>
    MANIFEST.tabBar!.list.some((item) => item.pagePath === pagePath)

  const onSimulatorEvent = <T,>(channel: string, listener: (payload: T) => void): (() => void) => {
    let set = listeners.get(channel)
    if (!set) { set = new Set(); listeners.set(channel, set) }
    const fn = listener as Listener
    set.add(fn)
    return () => { set.delete(fn) }
  }

  const host: MiniAppHost = {
    appId: APP_ID,
    pagePath: rootPagePath,
    query: {},
    rootWindowConfig: windowConfigFor(rootPagePath),
    resourceBaseUrl: 'http://localhost:1234/',
    appSessionId: APP_SESSION_ID,

    getTabBarConfig: () => MANIFEST.tabBar ?? null,
    getHomePagePath: () => MANIFEST.entryPagePath ?? '',
    getRenderPreloadUrl: () => 'about:blank',
    // The page path rides the fragment so a test can read which page a mounted
    // render host is actually showing.
    createRenderHostUrl: (_bridgeId, pagePath) => `about:blank#${pagePath ?? rootPagePath}`,

    openPage: async (pagePath): Promise<PageOpenResult> => {
      recorder.openedPages.push(pagePath)
      if (gate) await gate
      nextPageId += 1
      const opened: PageOpenResult = {
        bridgeId: `page-${nextPageId}`,
        pagePath,
        windowConfig: windowConfigFor(pagePath),
        isTab: isTab(pagePath),
      }
      recorder.openedEntries.push({ pagePath: opened.pagePath, bridgeId: opened.bridgeId })
      recorder.calls.push({ kind: 'openPage', pagePath: opened.pagePath, bridgeId: opened.bridgeId })
      return opened
    },
    closePage: (bridgeId) => {
      recorder.closedPages.push(bridgeId)
      recorder.calls.push({ kind: 'closePage', bridgeId })
    },
    notifyLifecycle: (bridgeId, event) => {
      recorder.lifecycles.push({ bridgeId, event })
      recorder.calls.push({ kind: 'lifecycle', bridgeId, event })
    },
    notifyNavCallback: (payload) => {
      recorder.navCallbacks.push({ appSessionId: APP_SESSION_ID, ...payload })
    },
    notifyActivePage: (bridgeId) => {
      recorder.calls.push({ kind: 'activePage', bridgeId })
    },
    notifyPageStack: (stack) => {
      recorder.pageStacks.push({ stack })
      recorder.calls.push({ kind: 'pageStack', stack: stack.map((e) => e.pagePath) })
    },

    onSimulatorEvent,
    // The session filter the real hosts apply: a payload naming a different
    // session belongs to the other frame alive during a soft reload.
    onSessionEvent: <T,>(channel: string, listener: (payload: T) => void) =>
      onSimulatorEvent<T>(channel, (payload) => {
        const sid = (payload as { appSessionId?: unknown } | null | undefined)?.appSessionId
        if (typeof sid === 'string' && sid !== APP_SESSION_ID) return
        listener(payload)
      }),
  }

  return { host, recorder }
}

export interface BootedShell {
  container: HTMLElement
  recorder: HostRecorder
  bridgeId: string
}

export async function bootShell(rootPagePath: string): Promise<BootedShell> {
  const { host, recorder } = createFakeHost(rootPagePath)
  let container!: HTMLElement
  await act(async () => {
    container = render(<MiniAppFrame host={host} bridgeId={ROOT_BRIDGE_ID} />).container
  })
  return { container, recorder, bridgeId: ROOT_BRIDGE_ID }
}

export function homeButton(container: HTMLElement): Element | null {
  return container.querySelector('.nav-bar__home')
}

/** Every page kept mounted in the DOM, leaked ones included. */
export function mountedPageCount(container: HTMLElement): number {
  return container.querySelectorAll('.device-shell__webview').length
}

/** The single page currently on screen, read off the mounted render hosts. */
export function visiblePagePath(container: HTMLElement): string | null {
  const shown = Array.from(container.querySelectorAll('.device-shell__webview'))
    .filter((view) => (view as HTMLElement).style.display !== 'none')
  if (shown.length !== 1) return null
  return shown[0].getAttribute('src')?.split('#')[1] ?? null
}

export function latestStack(recorder: HostRecorder): string[] | undefined {
  return recorder.pageStacks[recorder.pageStacks.length - 1]?.stack.map((e) => e.pagePath)
}

/** Drives a routing call the way the service host issues one. */
export async function serviceNav(
  recorder: HostRecorder,
  name: NavActionPayload['name'],
  pagePath: string,
): Promise<void> {
  await act(async () => {
    recorder.fire(E.NAV_ACTION, {
      appSessionId: APP_SESSION_ID,
      bridgeId: ROOT_BRIDGE_ID,
      name,
      params: { url: `/${pagePath}` },
      callbacks: {},
    })
    await Promise.resolve()
    await Promise.resolve()
  })
}
