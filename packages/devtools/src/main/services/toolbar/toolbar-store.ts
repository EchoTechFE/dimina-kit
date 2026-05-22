import type { ToolbarAction, ToolbarActionInput } from '../../../shared/types.js'

/**
 * Per-context store for host-registered toolbar actions.
 *
 * The toolbar is modelled as "one table the host recomputes from its current
 * state": `set()` replaces the whole table atomically. The non-serialisable
 * `handler` is kept main-process side; `list()` projects to `{id,label}[]`
 * for the IPC boundary, and `getHandler()` resolves a handler by id.
 */
export interface ToolbarStore {
  /**
   * Atomically replace the whole toolbar table. Validates that every `id` is
   * unique up-front; on a duplicate it throws WITHOUT mutating the store, so
   * a rejected batch leaves the previous table intact.
   */
  set(actions: ToolbarActionInput[]): void
  /** Project the current table to `{id,label}[]` — no `handler` leaks out. */
  list(): ToolbarAction[]
  /** Resolve the handler stored under `id`, or `undefined` if unknown. */
  getHandler(id: string): (() => void | Promise<void>) | undefined
}

export function createToolbarStore(): ToolbarStore {
  let actions: ToolbarActionInput[] = []

  return {
    set(next) {
      const seen = new Set<string>()
      for (const action of next) {
        if (seen.has(action.id)) {
          throw new Error(`Duplicate toolbar action id "${action.id}"`)
        }
        seen.add(action.id)
      }
      // Copy so a later host mutation of the passed array can't reach in.
      actions = next.slice()
    },
    list() {
      return actions.map(({ id, label }) => ({ id, label }))
    },
    getHandler(id) {
      return actions.find((a) => a.id === id)?.handler
    },
  }
}
