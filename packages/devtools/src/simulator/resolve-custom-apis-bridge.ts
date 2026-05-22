/**
 * Resolves the simulator custom-apis bridge that a preload script exposes as
 * `window.__diminaCustomApis` (see `installCustomApisBridge()` in
 * `src/preload/runtime/custom-apis.ts`).
 *
 * The bridge is *expected* to be present whenever the simulator runs inside
 * Electron: the default simulator preload installs it. A host that supplies a
 * custom `preloadPath` must call `installCustomApisBridge()` itself — forget
 * that, and every `wx.<customApi>()` from the mini-program silently no-ops
 * because no proxy handler ever gets registered.
 *
 * To turn that silent failure into a visible one, this helper warns when it
 * runs inside Electron but finds no bridge. Outside Electron (dev-server smoke
 * tests, plain browser) the bridge is legitimately absent, so it stays quiet.
 */

export interface CustomApisBridge {
  list(): Promise<string[]>
  invoke(name: string, params: unknown): Promise<unknown>
}

/** True when the given window's renderer is running inside an Electron process. */
function isElectronRenderer(win: Pick<Window, 'navigator'>): boolean {
  const ua = win.navigator?.userAgent
  return typeof ua === 'string' && ua.includes('Electron')
}

/**
 * Returns the custom-apis bridge, or `undefined` when it is unavailable.
 *
 * When running inside Electron without a bridge, emits a `console.warn` so a
 * host that forgot `installCustomApisBridge()` in its custom preload sees the
 * problem at the failure site instead of debugging a silent `wx.<api>()`.
 */
export function resolveCustomApisBridge(
  win: Pick<Window, 'navigator'> & { __diminaCustomApis?: CustomApisBridge } = window,
): CustomApisBridge | undefined {
  const bridge = win.__diminaCustomApis
  if (bridge) return bridge

  if (isElectronRenderer(win)) {
    console.warn(
      '[devtools] simulator custom-apis bridge (`window.__diminaCustomApis`) is missing — ' +
        'host-registered `wx.<customApi>()` calls will silently no-op. ' +
        'A custom preload script must call `installCustomApisBridge()` ' +
        "(from '@dimina-kit/devtools/preload').",
    )
  }
  return undefined
}
