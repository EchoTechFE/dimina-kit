export type SimulatorApiHandler = (params: unknown) => unknown | Promise<unknown>

export interface SimulatorApiRegistry {
  register(name: string, handler: SimulatorApiHandler): () => void
  list(): string[]
  invoke(name: string, params: unknown): Promise<unknown>
  clear(): void
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

export const simulatorApiRegistry: SimulatorApiRegistry = createSimulatorApiRegistry()
