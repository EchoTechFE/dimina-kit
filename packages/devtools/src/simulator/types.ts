/** Callback type used by API functions */
export type Callback = (...args: unknown[]) => void

/**
 * Context (`this`) available to each registered miniapp API handler.
 * Bound by AppManager.registerApi → MiniApp.invokeApi.
 */
export interface MiniAppContext {
  createCallbackFunction(fn: unknown): Callback | undefined
  appId: string
  parent?: {
    el?: Element
    getStatusBarRect?: () => { height: number }
  }
}
