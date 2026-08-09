/**
 * Shared fixtures for the DeviceShell component suites: a fake native-host
 * bridge plus the probes those suites read the shell's behavior through.
 *
 * The bridge is a ledger, not just a stub — it records every page the shell
 * asked to open, every page it asked to close and every lifecycle it pushed, in
 * the order the host received them. A suite can therefore assert both that no
 * render host is dropped from state without being torn down AND that the
 * lifecycle the service layer needs actually reached the bridge, not merely
 * that the reducer produced the right effect list. `calls` is the same ledger
 * with every kind interleaved, which is what an assertion about the ORDER of
 * two different calls needs. `gateOpenPage` holds `openPage` unresolved to
 * reproduce the IPC round-trip window a user can click through.
 */
import React from 'react'
import { act, render } from '@testing-library/react'
import { SIMULATOR_EVENTS as E } from '../../../shared/bridge-channels'
import type {
  ActivePagePayload,
  AppManifest,
  NavActionPayload,
  NavCallbackPayload,
  PageLifecycleEvent,
  PageOpenResult,
  PageStackPayload,
  PageWindowConfig,
} from '../../../shared/bridge-channels'
import { SimulatorMiniApp } from '../../simulator-mini-app'
import { DeviceShell } from '../device-shell'

export const APP_ID = 'test-app'
export const HOME_PAGE = 'pages/home/home'
export const OTHER_TAB_PAGE = 'pages/mine/mine'
export const INNER_PAGE = 'pages/detail/detail'
/** A non-tab page whose `homeButton: true` lifts the stack-bottom requirement. */
export const FORCED_PAGE = 'pages/promo/promo'
/** The bridgeId main hands back for the page a spawn mounts. */
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
 * One call the shell made on the bridge. Relative order between two different
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
  pageStacks: PageStackPayload[]
  openedPages: string[]
  /** Every page the shell asked main to open, with the bridgeId it received. */
  openedEntries: OpenedPage[]
  /** Every bridgeId the shell asked main to tear down. */
  closedPages: string[]
  /**
   * Every lifecycle the shell pushed over the bridge, in arrival order. The
   * service layer only ever learns a page hid, showed or unloaded through this
   * call, so a shell that computes the right effects but never delivers them is
   * indistinguishable from a correct one without reading this ledger.
   */
  lifecycles: LifecycleRecord[]
  /** Every bridge call above, interleaved in the order the host received them. */
  calls: HostCall[]
  /** Pushes a main→simulator event exactly the way the preload bridge does. */
  fire(channel: string, payload: unknown): void
  /** Holds every subsequent `openPage` unresolved until the returned fn runs. */
  gateOpenPage(): () => void
}

export function installNativeHostMock(rootPagePath: string): HostRecorder {
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

  const host = {
    enabled: true,
    device: undefined,
    spawn: async () => ({
      appSessionId: APP_SESSION_ID,
      bridgeId: ROOT_BRIDGE_ID,
      pagePath: rootPagePath,
      resolvedPagePath: rootPagePath,
      pageFallbackApplied: false,
      serviceWcId: 1,
      resourceBaseUrl: 'http://localhost:1234/',
      root: 'main',
      manifest: MANIFEST,
      rootWindowConfig: windowConfigFor(rootPagePath),
    }),
    dispose: () => {},
    openPage: async (opts: { pagePath: string }): Promise<PageOpenResult> => {
      recorder.openedPages.push(opts.pagePath)
      if (gate) await gate
      nextPageId += 1
      const opened: PageOpenResult = {
        bridgeId: `page-${nextPageId}`,
        pagePath: opts.pagePath,
        windowConfig: windowConfigFor(opts.pagePath),
        isTab: isTab(opts.pagePath),
      }
      recorder.openedEntries.push({ pagePath: opened.pagePath, bridgeId: opened.bridgeId })
      recorder.calls.push({ kind: 'openPage', pagePath: opened.pagePath, bridgeId: opened.bridgeId })
      return opened
    },
    closePage: (bridgeId: string) => {
      recorder.closedPages.push(bridgeId)
      recorder.calls.push({ kind: 'closePage', bridgeId })
    },
    notifyLifecycle: (payload: { bridgeId: string; event: PageLifecycleEvent }) => {
      recorder.lifecycles.push({ bridgeId: payload.bridgeId, event: payload.event })
      recorder.calls.push({ kind: 'lifecycle', bridgeId: payload.bridgeId, event: payload.event })
    },
    notifyNavCallback: (payload: NavCallbackPayload) => { recorder.navCallbacks.push(payload) },
    notifyApiResponse: () => {},
    notifyActivePage: (payload: ActivePagePayload) => {
      recorder.calls.push({ kind: 'activePage', bridgeId: payload.bridgeId })
    },
    notifyPageStack: (payload: PageStackPayload) => {
      recorder.pageStacks.push(payload)
      recorder.calls.push({ kind: 'pageStack', stack: payload.stack.map((e) => e.pagePath) })
    },
    // The page path rides the fragment so a test can read which page a mounted
    // render host is actually showing.
    createRenderHostUrl: (opts: { pagePath: string }) => `about:blank#${opts.pagePath}`,
    renderPreloadUrl: 'about:blank',
    onSimulatorEvent: (channel: string, listener: Listener) => {
      let set = listeners.get(channel)
      if (!set) { set = new Set(); listeners.set(channel, set) }
      set.add(listener)
      return () => { set!.delete(listener) }
    },
  }
  window.__diminaNativeHost = host as unknown as Window['__diminaNativeHost']
  return recorder
}

export interface BootedShell {
  container: HTMLElement
  recorder: HostRecorder
  bridgeId: string
}

export async function bootShell(rootPagePath: string): Promise<BootedShell> {
  const recorder = installNativeHostMock(rootPagePath)
  const miniApp = new SimulatorMiniApp({ appId: APP_ID, scene: 1001, pagePath: rootPagePath })
  const bridgeId = await miniApp.spawn()
  let container!: HTMLElement
  await act(async () => {
    container = render(<DeviceShell miniApp={miniApp} bridgeId={bridgeId} />).container
  })
  return { container, recorder, bridgeId }
}

export function installBrowserGlobals(): void {
  window.__diminaCustomApis = { list: async () => [], invoke: async () => undefined }
}

export function clearBrowserGlobals(): void {
  delete (window as { __diminaNativeHost?: unknown }).__diminaNativeHost
  delete (window as { __diminaCustomApis?: unknown }).__diminaCustomApis
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
