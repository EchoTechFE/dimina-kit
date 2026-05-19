declare module 'container-api' {
  export class Application {
    el: HTMLElement
    parent: { root: HTMLElement | null; updateDeviceBarColor?: (color: string) => void } | null
    presentView(view: MiniApp, useCache: boolean): Promise<void>
    dismissView(opts?: { destroy?: boolean }): Promise<void>
  }

  export class MiniApp {
    constructor(opts: {
      appId: string
      scene: number
      name?: string
      logo?: string
      pagePath?: string
      query?: Record<string, string>
      restoreStack?: unknown[]
    })
    apiRegistry: Record<string, ((...args: unknown[]) => unknown) | undefined>
    registerApi(name: string, handler: (...args: unknown[]) => unknown): void
    invokeApi(name: string, params?: unknown): void
  }
}
