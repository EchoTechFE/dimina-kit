/**
 * Native-host API_CALL handler installed inside the main-window preload.
 *
 * Goal: let the main devtools window double as a simulator when the
 * bridge-router forwards `simulator:api-call` to its webContents (the
 * default path in e2e tests, where `dmb:spawn` is invoked from mainWindow
 * directly with no explicit `simulatorWcId`).
 *
 * Unlike `simulator/main.tsx` (which boots a full DeviceShell + SimulatorMiniApp),
 * this runner is renderer-agnostic: it just owns a name→handler table plus
 * a sentinel-based callback capture identical in shape to the simulator's
 * `runApiAsync`. The MiniAppContext stub it constructs is the smallest one
 * the built-in handlers expect (`appId`, `createCallbackFunction`, parent
 * with `el.querySelector` returning the simulated viewport rect).
 */
import type { MiniAppContext } from '../../simulator/types.js'

// No `this` parameter: handlers are always invoked through `.call(ctx, …)`
// below with an explicit context object, so the declared type never needs to
// constrain (or widen away) the caller's `this`.
type LooseApiHandler = (params?: unknown) => unknown | Promise<unknown>

export interface ApiRunVerdict {
  ok: boolean
  result?: unknown
  errMsg?: string
}

interface ApiRunnerContext extends MiniAppContext {
  /** Dummy properties some upstream handlers introspect. */
  appId: string
}

function makeBaseContext(): ApiRunnerContext {
  // Minimal viewport rect: enough for handlers that read
  // `parent.el.querySelector('.dimina-native-webview__root').getBoundingClientRect()`
  // (see simulator-api.ts readWindowMetrics).
  const fakeRect = { width: 390, height: 844, x: 0, y: 0, top: 0, left: 0, right: 390, bottom: 844 }
  const fakeRoot = {
    getBoundingClientRect: () => fakeRect,
  } as unknown as Element
  return {
    appId: '',
    createCallbackFunction: () => undefined,
    parent: {
      el: {
        querySelector: () => fakeRoot,
      } as unknown as Element,
      getStatusBarRect: () => ({ height: 0 }),
    },
  }
}

export function runApiAsync(
  handlers: Record<string, LooseApiHandler | undefined>,
  name: string,
  params: unknown,
): Promise<ApiRunVerdict> {
  const handler = handlers[name]
  if (!handler) {
    return Promise.resolve({ ok: false, errMsg: `${name}:fail no handler` })
  }

  return new Promise<ApiRunVerdict>((resolve) => {
    let resolved = false
    const finish = (verdict: ApiRunVerdict): void => {
      if (resolved) return
      resolved = true
      resolve(verdict)
    }

    const SUCCESS = Symbol('main-cb-success')
    const FAIL = Symbol('main-cb-fail')
    const COMPLETE = Symbol('main-cb-complete')

    const base = makeBaseContext()
    const ctx: ApiRunnerContext = {
      ...base,
      createCallbackFunction(id: unknown) {
        if (id === undefined || id === null) return undefined
        return (...args: unknown[]) => {
          const arg = args[0]
          if (id === SUCCESS) {
            finish({ ok: true, result: arg })
          } else if (id === FAIL) {
            const errMsg =
              arg && typeof arg === 'object' && 'errMsg' in (arg as Record<string, unknown>)
                ? String((arg as { errMsg?: unknown }).errMsg)
                : `${name}:fail`
            finish({ ok: false, errMsg, result: arg })
          }
        }
      },
    }

    const userParams =
      params && typeof params === 'object' && !Array.isArray(params)
        ? { ...(params as Record<string, unknown>) }
        : {}
    const hadSuccess = userParams.success !== undefined && userParams.success !== null
    const hadFail = userParams.fail !== undefined && userParams.fail !== null
    const hadComplete = userParams.complete !== undefined && userParams.complete !== null

    userParams.success = SUCCESS
    userParams.fail = FAIL
    if (hadComplete) userParams.complete = COMPLETE

    try {
      const ret = (handler as LooseApiHandler).call(ctx, userParams)
      if (ret && typeof (ret as PromiseLike<unknown>).then === 'function') {
        Promise.resolve(ret as PromiseLike<unknown>).then(
          (r) => finish({ ok: true, result: r }),
          (err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err)
            finish({ ok: false, errMsg: `${name}:fail ${msg}` })
          },
        )
        return
      }
      if (!hadSuccess && !hadFail) {
        finish({ ok: true, result: ret })
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      finish({ ok: false, errMsg: `${name}:fail ${msg}` })
    }
  })
}
