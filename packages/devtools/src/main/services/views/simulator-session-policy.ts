/**
 * Referer + CORS webRequest policy for the simulator runtime's sessions.
 *
 * The native render/service hosts fetch the compiled `<appId>/…` resources
 * cross-origin and need a WeChat-style page-frame `Referer`; this installs that
 * policy on the shared fallback session AND on every per-project
 * `persist:miniapp-<key>` partition (current + future) via the partition
 * configurator registry, so isolated projects load resources identically.
 *
 * TEARDOWN: a `webRequest` listener is per-session and there is exactly one
 * slot per (session, event) — re-installing replaces, never stacks. But the
 * configurator registration itself leaks if discarded: re-creating the
 * WorkbenchApp in the same process would register a second configurator that
 * keeps firing for every future partition. So this returns a {@link Disposable}
 * that unregisters the configurator AND clears the listeners off every session
 * it touched. Wire it into the context registry like any other module.
 */

import { session, type Session } from 'electron'
import { toDisposable, type Disposable } from '@dimina-kit/electron-deck/main'
import { getSimulatorServicewechatReferer } from '../simulator/referer.js'
import {
  registerMiniappSessionConfigurator,
  SHARED_MINIAPP_PARTITION,
} from './miniapp-partition.js'

/** Apply the simulator runtime's referer + CORS webRequest policy to one
 * session. Each session installs its own listeners (a webRequest listener is
 * per-session), so this runs once per partition. */
function applySimulatorWebRequestPolicy(simulatorSession: Session): void {
  simulatorSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const forcedReferer = getSimulatorServicewechatReferer()
    if (forcedReferer) {
      details.requestHeaders['Referer'] = forcedReferer
    }
    callback({ requestHeaders: details.requestHeaders })
  })

  simulatorSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders ?? {}
    // CORS for the native render/service hosts to fetch compiled app resources
    // cross-origin. (The COOP/COEP cross-origin-isolation headers were only for
    // the removed default-path SharedArrayBuffer sync Worker — dropped.)
    headers['access-control-allow-origin'] = ['*']
    headers['access-control-allow-headers'] = ['*']
    headers['access-control-allow-methods'] = ['*']
    callback({ responseHeaders: headers })
  })
}

/** Remove the policy listeners from a session (passing `null` clears the slot). */
function clearSimulatorWebRequestPolicy(simulatorSession: Session): void {
  try {
    simulatorSession.webRequest.onBeforeSendHeaders(null)
    simulatorSession.webRequest.onHeadersReceived(null)
  } catch {
    // Session already gone (app shutdown) — nothing to clear.
  }
}

/**
 * Install the simulator referer/CORS policy on the shared fallback session and
 * register a configurator so every per-project partition session gets it too.
 * Returns a disposable that unregisters the configurator and clears the policy
 * off every session it installed on — call its teardown when the owning
 * context is disposed so re-creating the app never leaks a duplicate
 * configurator/listener.
 */
export function setupSimulatorSessionPolicy(): Disposable {
  const configured = new Set<Session>()
  function install(sess: Session): void {
    if (configured.has(sess)) return
    configured.add(sess)
    applySimulatorWebRequestPolicy(sess)
  }

  // Shared fallback session (pre-warm pool + unknown-appId path).
  install(session.fromPartition(SHARED_MINIAPP_PARTITION))
  // Every per-project miniapp partition session (current + future) gets the
  // same referer/CORS policy so isolated projects load resources identically.
  const unregister = registerMiniappSessionConfigurator((sess) => install(sess))

  return toDisposable(() => {
    unregister()
    for (const sess of configured) clearSimulatorWebRequestPolicy(sess)
    configured.clear()
  })
}
