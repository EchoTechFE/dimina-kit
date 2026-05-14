import { simulatorApiRegistry, type SimulatorApiHandler } from './services/simulator/custom-apis.js'

export type { SimulatorApiHandler } from './services/simulator/custom-apis.js'

/**
 * Register a handler for a simulator API callable from mini-program code.
 *
 * The handler runs in the Electron main process (Node.js context) and may
 * use any main-process capability (filesystem, network, native deps). When
 * the mini-program invokes `wx.<name>(params)` inside the simulator, the
 * simulator forwards the call over IPC and resolves to the handler's return
 * value. Errors thrown by the handler propagate back as a rejection.
 *
 * Re-registering the same name silently replaces the previous handler.
 * The returned disposer removes only the registration it created — if the
 * name was overwritten by a later `registerSimulatorApi`, calling the
 * earlier disposer is a no-op.
 *
 * @example
 *   registerSimulatorApi('myCompany.login', async ({ username }) => {
 *     return await callInternalAuth(username)
 *   })
 */
export function registerSimulatorApi(
  name: string,
  handler: SimulatorApiHandler,
): () => void {
  return simulatorApiRegistry.register(name, handler)
}
