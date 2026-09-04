/**
 * Per-channel IPC multiplexing, invoke and sync alike.
 *
 * `ipcMain.handle` accepts exactly ONE handler per channel process-wide and
 * throws on a second, and `event.returnValue` on a sync (`ipcMain.on` +
 * `sendSync`) channel is single-valued — but several call sites in this repo
 * register the same channel name once per owner (a per-window panel service,
 * a per-window bridge router) each closing over its own state. The mux
 * installs a single real `ipcMain` registration per channel and dispatches
 * each message to the owner that claims the calling sender, so e.g. window
 * B's panel reads window B's data.
 *
 * Registrations are scanned newest-first: with a single owner this is a
 * pass-through, matching plain `ipcMain.handle`/`ipcMain.on` semantics where
 * re-registering a channel replaced the previous handler. The channel is
 * unregistered only when the last owner removes its entry.
 *
 * The caller passes its own `ipcMain` rather than this module importing it:
 * nothing else reachable from this package's `/main` entry imports a VALUE
 * from `electron`, and downstream tests depend on that — a `vi.mock('electron',
 * factory)` whose factory reaches this entry would otherwise deadlock on
 * itself, hanging the test run at import with no timeout to break it.
 */
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'

/** One owner's registration on a channel, plus its claim on a sender. */
export interface MuxEntry<E, R> {
  claims: (event: E) => boolean
  handle: (event: E, ...args: unknown[]) => R
}

export type InvokeMuxEntry = MuxEntry<IpcMainInvokeEvent, unknown>
export type SyncMuxEntry = MuxEntry<IpcMainEvent, void>

/**
 * The claimant for `event`, or — when nobody claims it — the most recent
 * registration. The fallback keeps single-owner behaviour intact: that owner
 * runs its own logic and reports its own error/rejection, instead of the mux
 * inventing one.
 */
function pickEntry<E, R>(entries: MuxEntry<E, R>[], event: E): MuxEntry<E, R> {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.claims(event)) return entries[i]!
  }
  return entries[entries.length - 1]!
}

const invokeMux = new Map<string, InvokeMuxEntry[]>()

/** Register on an invoke channel; returns the disposer for THIS registration. */
export function addMuxedInvokeHandler(
  ipcMain: IpcMain,
  channel: string,
  entry: InvokeMuxEntry,
): () => void {
  let entries = invokeMux.get(channel)
  if (!entries) {
    entries = []
    invokeMux.set(channel, entries)
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const live = invokeMux.get(channel)
      if (!live || live.length === 0) throw new Error(`No handler registered for '${channel}'`)
      return pickEntry(live, event).handle(event, ...args)
    })
  }
  const owner = entries
  owner.push(entry)
  return () => {
    const at = owner.indexOf(entry)
    if (at !== -1) owner.splice(at, 1)
    if (owner.length === 0 && invokeMux.get(channel) === owner) {
      invokeMux.delete(channel)
      ipcMain.removeHandler(channel)
    }
  }
}

const syncMux = new Map<string, SyncMuxEntry[]>()
/** The installed `ipcMain.on` listener per sync channel, keyed by its entry list. */
const syncListeners = new WeakMap<SyncMuxEntry[], (event: IpcMainEvent, ...args: unknown[]) => void>()

/**
 * Register on a synchronous (`event.returnValue`) channel; returns the
 * disposer for THIS registration. A single listener runs per message so
 * exactly one owner writes `returnValue`.
 */
export function addMuxedSyncListener(
  ipcMain: IpcMain,
  channel: string,
  entry: SyncMuxEntry,
): () => void {
  let entries = syncMux.get(channel)
  if (!entries) {
    entries = []
    syncMux.set(channel, entries)
    const listener = (event: IpcMainEvent, ...args: unknown[]): void => {
      const live = syncMux.get(channel)
      if (!live || live.length === 0) return
      pickEntry(live, event).handle(event, ...args)
    }
    syncListeners.set(entries, listener)
    ipcMain.on(channel, listener)
  }
  const owner = entries
  owner.push(entry)
  return () => {
    const at = owner.indexOf(entry)
    if (at !== -1) owner.splice(at, 1)
    if (owner.length === 0 && syncMux.get(channel) === owner) {
      syncMux.delete(channel)
      const listener = syncListeners.get(owner)
      if (listener) {
        ipcMain.removeListener(channel, listener)
        syncListeners.delete(owner)
      }
    }
  }
}
