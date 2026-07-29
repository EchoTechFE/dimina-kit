/**
 * Main-process registration supplied by a downstream host. The script must be
 * a built renderer bundle that calls {@link registerSimulatorUiExtension}.
 */
export interface SimulatorUiExtensionRegistration {
  /** Stable, context-unique extension identifier. */
  id: string
  /** Absolute path to a trusted renderer JavaScript bundle. */
  rendererScriptPath: string
}

/**
 * Handle returned to the host that registered an extension. `invoke` crosses
 * into the live simulator renderer and calls the extension's renderer-side
 * method.
 */
export interface SimulatorUiExtensionHandle {
  dispose(): void | Promise<void>
  invoke<T = unknown>(method: string, params?: unknown): Promise<T>
}

export interface SimulatorUiMountContext {
  /** Stable host-owned layer inside the active device frame. */
  overlayRoot: HTMLElement
  /** App currently represented by this DeviceShell. */
  appId: string
  /** Aborted before the mount is disposed or moved to another shell. */
  signal: AbortSignal
}

export interface SimulatorChromeAction {
  name: 'capsule.more'
  appId: string
  appName: string
  pagePath: string
}

/**
 * Renderer-side half of a simulator UI extension.
 *
 * The extension owns its DOM and business semantics. Dimina owns the device
 * layer, active-shell selection, reload lifecycle, and chrome-action delivery.
 */
export interface SimulatorUiRendererExtension {
  id: string
  mount?(context: SimulatorUiMountContext): void | (() => void)
  invoke?(method: string, params: unknown): unknown | Promise<unknown>
  /**
   * Return `false` to let another extension handle the action. Any other
   * resolved value marks it handled.
   */
  onChromeAction?(action: SimulatorChromeAction): boolean | void | Promise<boolean | void>
}

export interface SimulatorUiRuntimeBridge {
  register(extension: SimulatorUiRendererExtension): () => void
  unregister(id: string): void
  has(id: string): boolean
  invoke(id: string, method: string, params: unknown): Promise<unknown>
}

type SimulatorUiGlobal = typeof globalThis & {
  __diminaSimulatorUi?: SimulatorUiRuntimeBridge
}

/**
 * Register the renderer-side implementation from a host bundle loaded through
 * `instance.registerSimulatorUiExtension`.
 */
export function registerSimulatorUiExtension(
  extension: SimulatorUiRendererExtension,
): () => void {
  const bridge = (globalThis as SimulatorUiGlobal).__diminaSimulatorUi
  if (!bridge) {
    throw new Error('Dimina simulator UI runtime is not available')
  }
  return bridge.register(extension)
}
