import type { RendererNotifier } from '../notifications/renderer-notifier.js'
import type { CompileLogBuffer } from './compile-log-buffer.js'
import type { SessionStatusStore } from './session-status-store.js'

/**
 * Wraps the renderer notifier so the two compile-state pushes ALSO land in
 * the main-process authorities (session-status store + compile-log buffer)
 * before the renderer broadcast.
 *
 * `ctx.notify` is the single outlet every status transition and log line
 * already flows through (`workspace-service`'s `sendStatus` / `onLog`
 * closures), so tapping at this gate keeps ONE bookkeeping site instead of a
 * second call next to every producer — and the stale-session generation
 * guard upstream of the notify call protects the store/buffer for free.
 *
 * A fresh open (`'compiling'` without `hotReload`) starts a new compile
 * timeline, so it clears the buffer; watcher rebuilds never pass through
 * `'compiling'` and keep appending to the same timeline.
 */
export function tapNotifierIntoStores(
  notify: RendererNotifier,
  status: SessionStatusStore,
  compileLogs: CompileLogBuffer,
): RendererNotifier {
  return {
    ...notify,
    projectStatus(payload) {
      if (payload.status === 'compiling' && payload.hotReload !== true) {
        compileLogs.clear()
      }
      status.record(payload)
      notify.projectStatus(payload)
    },
    compileLog(payload) {
      compileLogs.append(payload)
      notify.compileLog(payload)
    },
  }
}
