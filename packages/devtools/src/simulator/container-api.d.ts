declare module 'container-api' {
  export class Application {
    el: HTMLElement
    parent: { root: HTMLElement | null; updateDeviceBarColor?: (color: string) => void } | null
  }

  export const AppManager: {
    registerApi(name: string, handler: (...args: unknown[]) => unknown): void
    apiRegistry: Record<string, ((...args: unknown[]) => unknown) | undefined>
    appStack: unknown[]
    openApp(
      opts: {
        appId: string
        path: string
        scene: number
        destroy?: boolean
        restoreStack?: unknown[]
      },
      application: Application,
    ): void
  }

  export const HashRouter: {
    parse(hash: string): {
      appId: string
      stack: Array<{ pagePath: string; query?: Record<string, string> }>
    } | null
  }
}
