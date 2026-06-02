export type SimulatorApiHandler = (params: unknown) => unknown | Promise<unknown>

export interface SimulatorApiRegistry {
  register(name: string, handler: SimulatorApiHandler): () => void
  list(): string[]
  has(name: string): boolean
  invoke(name: string, params: unknown): Promise<unknown>
  clear(): void
}

/**
 * Bridge request/response shapes shared by the simulator-side preload
 * (`src/preload/runtime/custom-apis.ts`) and the two host-side dispatchers that
 * service it (the trusted main-window renderer proxy was the original path; the
 * native-host top-level WebContentsView dispatcher in the ViewManager is the
 * current one). Kept here next to the registry so both stay in lockstep with
 * the preload contract.
 */
export type CustomApiBridgeRequest =
  | { id: number; op: 'list' }
  | { id: number; op: 'invoke'; name: string; params: unknown }

export type CustomApiBridgeResponse =
  | { id: number; result: unknown }
  | { id: number; error: string }

/**
 * Run a single custom-apis bridge request against the given registry and return
 * the id-correlated response the preload's pending-map expects. Never throws:
 * a handler rejection / malformed request becomes an `{ id, error }` response so
 * the caller only has to ship it back over the bridge channel. The one shared
 * implementation behind both the `SimulatorCustomApiChannel` IPC handlers and
 * the native-host `ipc-message-host` dispatcher.
 */
export async function handleCustomApiBridgeRequest(
  apis: Pick<SimulatorApiRegistry, 'list' | 'invoke'>,
  req: CustomApiBridgeRequest,
): Promise<CustomApiBridgeResponse> {
  try {
    const result = req.op === 'list'
      ? apis.list()
      : await apis.invoke(req.name, req.params)
    return { id: req.id, result }
  } catch (err) {
    return { id: req.id, error: err instanceof Error ? err.message : String(err) }
  }
}

export function createSimulatorApiRegistry(): SimulatorApiRegistry {
  const handlers = new Map<string, SimulatorApiHandler>()
  return {
    register(name, handler) {
      handlers.set(name, handler)
      return () => {
        if (handlers.get(name) === handler) handlers.delete(name)
      }
    },
    list() {
      return Array.from(handlers.keys())
    },
    has(name) {
      return handlers.has(name)
    },
    async invoke(name, params) {
      const handler = handlers.get(name)
      if (!handler) throw new Error(`Simulator API "${name}" is not registered`)
      return await handler(params)
    },
    clear() {
      handlers.clear()
    },
  }
}
