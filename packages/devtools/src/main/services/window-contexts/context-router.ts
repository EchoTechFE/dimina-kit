import type { WebContents } from 'electron'
import { toDisposable, type Disposable } from '@dimina-kit/electron-deck/main'
import type { IpcContextSource } from '../../utils/ipc-context-source.js'
import type { SenderPolicy } from '../../utils/ipc-registry.js'

/**
 * What the router needs of a window context to place an incoming sender.
 * Kept to these two predicates so the router stays independent of the rest of
 * the context; the concrete context type is supplied by the caller.
 */
export interface RoutableWindowContext {
  /** Every sender this window accepts, app-shared trusted windows included. */
  senderPolicy: SenderPolicy
  /** Only the senders this window structurally owns (see sender-policy.ts). */
  ownsSender: SenderPolicy
}

/** Registry of live window contexts, and the authority on which one owns a sender. */
export interface WindowContextRouter<T extends RoutableWindowContext = RoutableWindowContext>
  extends IpcContextSource<T> {
  /** Register a window context; the returned Disposable unregisters it. */
  register(ctx: T): Disposable
  /**
   * The context owning `sender`, or null when no registered context claims it.
   * A pure query: looking a sender up never changes which context is active.
   */
  resolve(sender: WebContents): T | null
  /**
   * The context last marked active by `setActive`. With none marked — or after
   * the marked one unregisters — it falls back to the first still-registered
   * context, and null when none are.
   */
  active(): T | null
  /** Mark `ctx` active (on window focus). Ignored for unregistered contexts. */
  setActive(ctx: T): void
  list(): T[]
}

export function createWindowContextRouter<
  T extends RoutableWindowContext = RoutableWindowContext,
>(): WindowContextRouter<T> {
  const contexts: T[] = []
  let activeCtx: T | null = null

  const first = (): T | null => contexts[0] ?? null

  return {
    register(ctx) {
      contexts.push(ctx)
      activeCtx ??= ctx
      return toDisposable(() => {
        const at = contexts.indexOf(ctx)
        if (at === -1) return
        contexts.splice(at, 1)
        if (activeCtx === ctx) activeCtx = first()
      })
    },

    resolve(sender) {
      // Two passes, because the two predicates answer different questions.
      // `senderPolicy` also accepts host windows registered through
      // `registerTrustedWindow`, whose id map is app-wide — every context says
      // yes to such a sender, so a single-pass scan would hand it to whichever
      // window happened to register first. Pass one therefore only accepts a
      // context that OWNS the sender (its own renderer, settings window or
      // overlay views), which is unique by construction. Pass two covers the
      // accepted-but-unowned senders that are left: they belong to the app
      // rather than to a window, so the active window answers them.
      //
      // Neither pass moves "active": window focus is what decides which window
      // an app-wide sender belongs to, and a background window handling its own
      // IPC must not steal that answer from the focused one.
      for (const ctx of contexts) {
        if (ctx.ownsSender(sender)) return ctx
      }
      for (const ctx of contexts) {
        if (ctx.senderPolicy(sender)) return activeCtx ?? first()
      }
      return null
    },

    active() {
      return activeCtx ?? first()
    },

    setActive(ctx) {
      if (contexts.includes(ctx)) activeCtx = ctx
    },

    list() {
      return contexts.slice()
    },
  }
}
