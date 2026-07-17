// The pure AppData panel view, WeChat DevTools AppData layout: a Pages
// sidebar over one merged, collapsible (and optionally editable) data tree
// per page bridge, plus an expand/collapse/undo/redo toolbar. Pure
// presentation — bridge selection and data feeds live in the connected
// container (or the host, when it renders this view directly).
import React, { useRef, useState } from 'react'
import { AppDataTree, type AppDataTreeCommand } from './appdata-tree.js'
import type { AppDataSnapshot } from './appdata-accumulator.js'

/** The view's full input state: a snapshot plus which bridge tab is active. */
export interface AppDataPanelState {
  bridges: AppDataSnapshot['bridges']
  activeBridgeId: string | null
  entries: AppDataSnapshot['entries']
}

export interface AppDataPanelProps {
  state: AppDataPanelState
  onSelectBridge: (id: string) => void
  /** Whether the mini-program's runtime session is `running` — distinguishes "小程序未运行" from a true empty-data vacuum below. Defaults to true so callers that don't track runtime status keep the plain empty-data text. */
  isRuntimeRunning?: boolean
  /** Write-back for tree edits (setData path syntax keys). Absent → the tree
   * renders read-only: no checkboxes, double-click is inert. The return value
   * reports whether the write was dispatched to a live runtime: `false` (sync
   * or resolved) rejects the edit — the undo/redo stacks only advance on
   * success. `void`/`undefined` counts as success (fire-and-forget hosts). */
  onSetData?: (bridgeId: string, patch: Record<string, unknown>) => void | boolean | Promise<boolean>
}

function bridgeLabel(bridge: { id: string; pagePath: string | null }): string {
  return bridge.pagePath ?? bridge.id
}

/** One page's merged state: its component entries shallow-merged in insertion
 * order (later entries win) — the single root object the tree renders. */
function mergeEntries(bridgeEntries: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  for (const key of Object.keys(bridgeEntries)) {
    const data = bridgeEntries[key]
    if (data && typeof data === 'object') Object.assign(merged, data)
  }
  return merged
}

/** One committed edit — enough to replay in either direction. The stack lives
 * on the panel (not per tree) so undo keeps working after a page switch. */
interface EditRecord {
  bridgeId: string
  path: string
  before: unknown
  after: unknown
}

function ToolbarButton({ title, disabled, onClick, children }: {
  title: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="px-1.5 py-0.5 text-[12px] rounded text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  )
}

export function AppDataPanel({
  state,
  onSelectBridge,
  isRuntimeRunning = true,
  onSetData,
}: AppDataPanelProps) {
  const { bridges, activeBridgeId, entries } = state
  const [command, setCommand] = useState<AppDataTreeCommand | null>(null)
  const [undoStack, setUndoStack] = useState<EditRecord[]>([])
  const [redoStack, setRedoStack] = useState<EditRecord[]>([])
  // Replay (undo/redo) in-flight gate. The ref blocks reentry synchronously —
  // a second click before the async dispatch settles would read the SAME top
  // record and replay it twice, duplicating it onto the opposite stack. The
  // state mirror disables the buttons while pending.
  const replayInFlight = useRef(false)
  const [replayPending, setReplayPending] = useState(false)

  const emptyText = isRuntimeRunning ? '暂无页面数据（仅显示 Page 级 data）' : '小程序未运行'

  const issueCommand = (mode: AppDataTreeCommand['mode']): void => {
    if (!activeBridgeId) return
    setCommand({ seq: (command?.seq ?? 0) + 1, mode, bridgeId: activeBridgeId })
  }

  /** Dispatch a write, then run `apply` with its acceptance: only an explicit
   * `false` (sync or resolved) is a rejection — `void` keeps fire-and-forget
   * hosts working. A synchronous result settles synchronously so the stacks
   * (and their buttons) update in the same event turn as the click. A thrown
   * error or rejected promise (IPC torn down mid-edit) settles as a rejection
   * instead of escaping as an unhandled rejection. */
  const dispatch = (
    bridgeId: string,
    patch: Record<string, unknown>,
    apply: (ok: boolean) => void,
  ): void => {
    let result: void | boolean | Promise<boolean>
    try {
      result = onSetData?.(bridgeId, patch)
    } catch {
      apply(false)
      return
    }
    if (result instanceof Promise) {
      void result.then(v => v !== false, () => false).then(apply)
      return
    }
    apply(result !== false)
  }

  const commitEdit = (bridgeId: string) => (path: string, next: unknown, prev: unknown): void => {
    dispatch(bridgeId, { [path]: next }, (ok) => {
      if (!ok) return
      setUndoStack(stack => [...stack, { bridgeId, path, before: prev, after: next }])
      setRedoStack([])
    })
  }

  const bridgeIsLive = (bridgeId: string): boolean => bridges.some(b => b.id === bridgeId)

  /** Replay one record in either direction, gated so only ONE replay is ever
   * in flight: the ref rejects reentry synchronously (before any re-render),
   * the pending state disables the buttons for the async gap. */
  const replay = (
    record: EditRecord,
    value: unknown,
    move: (record: EditRecord) => void,
  ): void => {
    if (replayInFlight.current) return
    replayInFlight.current = true
    setReplayPending(true)
    dispatch(record.bridgeId, { [record.path]: value }, (ok) => {
      replayInFlight.current = false
      setReplayPending(false)
      // A rejected replay (runtime refused the write) leaves both stacks
      // untouched so the UI state never claims an undo that didn't happen.
      if (!ok) return
      move(record)
    })
  }

  const undo = (): void => {
    const record = undoStack.at(-1)
    if (!record) return
    if (!bridgeIsLive(record.bridgeId)) {
      // The page this edit targeted is gone — replaying it can only write into
      // the void. Drop the record without dispatching.
      setUndoStack(stack => stack.filter(r => r !== record))
      return
    }
    replay(record, record.before, (r) => {
      setUndoStack(stack => stack.filter(item => item !== r))
      setRedoStack(stack => [...stack, r])
    })
  }

  const redo = (): void => {
    const record = redoStack.at(-1)
    if (!record) return
    if (!bridgeIsLive(record.bridgeId)) {
      setRedoStack(stack => stack.filter(r => r !== record))
      return
    }
    replay(record, record.after, (r) => {
      setRedoStack(stack => stack.filter(item => item !== r))
      setUndoStack(stack => [...stack, r])
    })
  }

  if (bridges.length === 0) {
    return (
      <div className="flex flex-col overflow-hidden flex-1" data-testid="appdata-panel">
        <div className="text-[12px] text-text-dim text-center px-4 py-6">{emptyText}</div>
      </div>
    )
  }

  return (
    <div className="flex overflow-hidden flex-1" data-testid="appdata-panel">
      <div
        data-testid="appdata-pages"
        className="w-40 shrink-0 border-r border-border-subtle bg-bg-panel flex flex-col overflow-hidden"
      >
        <div className="px-2 py-1 text-[11px] text-text-secondary border-b border-border-subtle shrink-0">
          Pages
        </div>
        <div className="flex-1 overflow-y-auto" role="listbox">
          {bridges.map((b) => {
            const isActive = b.id === activeBridgeId
            return (
              <button
                key={b.id}
                data-testid="appdata-page-item"
                role="option"
                aria-selected={isActive}
                title={b.id}
                onClick={() => onSelectBridge(b.id)}
                className={
                  'block w-full text-left px-2 py-1 text-[11px] truncate '
                  + (isActive ? 'bg-accent/20 text-accent' : 'text-text-dim hover:bg-surface-3')
                }
              >
                {bridgeLabel(b)}
              </button>
            )
          })}
        </div>
      </div>
      <div className="flex-1 flex flex-col overflow-hidden">
        <div
          data-testid="appdata-toolbar"
          className="flex items-center gap-1 px-2 py-0.5 border-b border-border-subtle shrink-0 bg-bg-panel"
        >
          <ToolbarButton title="全部展开" onClick={() => issueCommand('expanded')}>⊕</ToolbarButton>
          <ToolbarButton title="全部收起" onClick={() => issueCommand('collapsed')}>⊖</ToolbarButton>
          <ToolbarButton title="撤销" disabled={undoStack.length === 0 || replayPending} onClick={undo}>↶</ToolbarButton>
          <ToolbarButton title="重做" disabled={redoStack.length === 0 || replayPending} onClick={redo}>↷</ToolbarButton>
        </div>
        {/* Keepalive: every bridge's tree stays mounted (hidden via display:
            none) so expand/collapse state survives page switches. */}
        <div className="flex-1 overflow-hidden relative">
          {bridges.map((b) => {
            const isActive = b.id === activeBridgeId
            const bridgeEntries = entries[b.id] ?? {}
            const hasData = Object.keys(bridgeEntries).length > 0
            return (
              <div
                key={b.id}
                data-bridge-id={b.id}
                className="absolute inset-0 flex-col overflow-y-auto"
                style={{ display: isActive ? 'flex' : 'none' }}
              >
                {hasData
                  ? (
                      <AppDataTree
                        root={mergeEntries(bridgeEntries)}
                        bridgeId={b.id}
                        command={command}
                        onCommit={onSetData ? commitEdit(b.id) : undefined}
                      />
                    )
                  : (
                      <div className="text-[12px] text-text-dim text-center px-4 py-6">{emptyText}</div>
                    )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
