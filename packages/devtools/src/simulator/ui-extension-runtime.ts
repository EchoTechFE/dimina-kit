import type {
  SimulatorChromeAction,
  SimulatorUiMountContext,
  SimulatorUiRendererExtension,
  SimulatorUiRuntimeBridge,
} from '../shared/simulator-ui'

interface MountedExtension {
  controller: AbortController
  dispose?: () => void
}

interface ActiveRoot {
  token: object
  overlayRoot: HTMLElement
  appId: string
}

interface InternalSimulatorUiRuntimeBridge extends SimulatorUiRuntimeBridge {
  dispatchChromeAction(action: SimulatorChromeAction): Promise<boolean>
}

const extensions = new Map<string, SimulatorUiRendererExtension>()
const mounted = new Map<string, MountedExtension>()
let activeRoot: ActiveRoot | null = null

function disposeMount(id: string): void {
  const current = mounted.get(id)
  if (!current) return
  mounted.delete(id)
  current.controller.abort()
  try {
    current.dispose?.()
  } catch (error) {
    console.error(`[simulator-ui] extension "${id}" dispose failed:`, error)
  }
}

function mountExtension(extension: SimulatorUiRendererExtension): void {
  disposeMount(extension.id)
  if (!activeRoot || !extension.mount) return
  const controller = new AbortController()
  const context: SimulatorUiMountContext = {
    overlayRoot: activeRoot.overlayRoot,
    appId: activeRoot.appId,
    signal: controller.signal,
  }
  try {
    const dispose = extension.mount(context)
    mounted.set(extension.id, {
      controller,
      dispose: typeof dispose === 'function' ? dispose : undefined,
    })
  } catch (error) {
    controller.abort()
    console.error(`[simulator-ui] extension "${extension.id}" mount failed:`, error)
  }
}

function remountAll(): void {
  for (const id of Array.from(mounted.keys())) disposeMount(id)
  for (const extension of extensions.values()) mountExtension(extension)
}

const bridge: InternalSimulatorUiRuntimeBridge = {
  register(extension) {
    const previous = extensions.get(extension.id)
    if (previous) disposeMount(previous.id)
    extensions.set(extension.id, extension)
    mountExtension(extension)
    return () => {
      if (extensions.get(extension.id) !== extension) return
      bridge.unregister(extension.id)
    }
  },
  unregister(id) {
    extensions.delete(id)
    disposeMount(id)
  },
  has(id) {
    return extensions.has(id)
  },
  async invoke(id, method, params) {
    const extension = extensions.get(id)
    if (!extension) throw new Error(`Simulator UI extension "${id}" is not registered`)
    if (!extension.invoke) {
      throw new Error(`Simulator UI extension "${id}" does not expose invoke()`)
    }
    return await extension.invoke(method, params)
  },
  async dispatchChromeAction(action) {
    for (const extension of extensions.values()) {
      if (!extension.onChromeAction) continue
      try {
        if (await extension.onChromeAction(action) !== false) return true
      } catch (error) {
        console.error(
          `[simulator-ui] extension "${extension.id}" chrome action failed:`,
          error,
        )
      }
    }
    return false
  },
}

;(globalThis as typeof globalThis & {
  __diminaSimulatorUi?: SimulatorUiRuntimeBridge
}).__diminaSimulatorUi = bridge

/**
 * Select the overlay root owned by the visible DeviceShell. The token prevents
 * an old shell's effect cleanup from clearing a newer shell promoted in the
 * same React commit.
 */
export function attachSimulatorUiRoot(
  overlayRoot: HTMLElement,
  appId: string,
): () => void {
  const token = {}
  activeRoot = { token, overlayRoot, appId }
  remountAll()
  return () => {
    if (activeRoot?.token !== token) return
    activeRoot = null
    remountAll()
  }
}

export function dispatchSimulatorChromeAction(
  action: SimulatorChromeAction,
): Promise<boolean> {
  return bridge.dispatchChromeAction(action)
}
