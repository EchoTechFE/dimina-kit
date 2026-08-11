/**
 * What the mini-app UI needs from whatever it is installed into: page
 * allocation, delivery of lifecycles and callbacks back to the service layer,
 * and the main→simulator event stream.
 *
 * Deliberately an interface rather than the host object itself. A host class
 * typically also carries device emulation (screen metrics, notch, the
 * `getSystemInfo` snapshot) and its own wx.* handler registry; neither is the
 * mini-app's business, and depending on the class would drag both in. Screen
 * geometry reaches the UI as plain numbers instead — see `MiniAppFrameProps`.
 *
 * Every member here is structural: a host satisfies this by having the methods,
 * not by importing anything from the runtime.
 */
import type {
  NavCallbackPayload,
  PageLifecycleEvent,
  PageOpenResult,
  PageStackEntry,
  PageWindowConfig,
  TabBarConfig,
} from '../shared/bridge-channels.js'

export interface MiniAppHost {
  readonly appId: string
  /**
   * The page the session ACTUALLY mounted. A host may have fallen back to a
   * different root page when the requested one was absent from the compiled
   * manifest, and the stack bottom must agree with what is live.
   */
  readonly pagePath: string
  readonly query: Record<string, string>
  readonly rootWindowConfig: PageWindowConfig | null
  /** Base URL the tabBar resolves its icon paths against; null before spawn. */
  readonly resourceBaseUrl: string | null
  readonly appSessionId: string | null

  getTabBarConfig(): TabBarConfig | null
  /**
   * The app's own home page — the home button's target and the page its
   * visibility rule compares against. `''` means unknown, which turns the rule
   * off rather than letting some other page masquerade as home.
   */
  getHomePagePath(): string
  getRenderPreloadUrl(): string
  createRenderHostUrl(
    bridgeId: string,
    pagePath?: string,
    isTab?: boolean,
    backgroundColor?: string,
  ): string

  /** Allocate a render page within the live session. */
  openPage(pagePath: string, query?: Record<string, unknown>): Promise<PageOpenResult>
  closePage(bridgeId: string): void
  notifyLifecycle(bridgeId: string, event: PageLifecycleEvent): void
  notifyNavCallback(payload: Omit<NavCallbackPayload, 'appSessionId'>): void
  /** Which page is the visible top of stack — panels and automation target it. */
  notifyActivePage(bridgeId: string): void
  /** The full ordered stack, bottom→top, on every stack change. */
  notifyPageStack(stack: PageStackEntry[]): void

  onSimulatorEvent<T = unknown>(channel: string, listener: (payload: T) => void): () => void
  /**
   * The same stream minus payloads naming a DIFFERENT app session. A soft
   * reload has two frames alive on one document, and a session-scoped event
   * executed by both would run the mini-app's side effect twice.
   */
  onSessionEvent<T = unknown>(channel: string, listener: (payload: T) => void): () => void
}
