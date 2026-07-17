// The AppData tree: one page's merged setData state as a collapsible,
// optionally editable tree (WeChat DevTools AppData semantics). Pure
// presentation + local expansion/edit state; committed edits are reported
// upward as (path, next, prev) — the panel owns the undo/redo stack and the
// actual write-back, and the rendered VALUES always come from `root`, never
// from a local echo of an edit.
import React, { useState } from 'react'

/** One expand/collapse-all toolbar action. Every keepalive tree instance sees
 * the same command object; a tree applies it only when `bridgeId` is its own
 * and `seq` is unseen — a background tree must not replay a command that was
 * aimed at the tree visible when the button was clicked. */
export interface AppDataTreeCommand {
  seq: number
  mode: 'expanded' | 'collapsed'
  bridgeId: string
}

export interface AppDataTreeProps {
  root: Record<string, unknown>
  bridgeId: string
  command: AppDataTreeCommand | null
  /** Absent → read-only tree (no checkboxes, double-click is inert). */
  onCommit?: (path: string, next: unknown, prev: unknown) => void
}

/** WeChat setData path syntax: dots between keys, indices in brackets. */
function childPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${key}]`
  return parent === '' ? key : `${parent}.${key}`
}

function isContainer(v: unknown): v is object {
  return typeof v === 'object' && v !== null
}

function sortedEntries(value: object): Array<[string | number, unknown]> {
  // Array.isArray narrows to any[]; the explicit unknown[] view keeps the
  // elements typed (type-coverage counts every any-typed identifier).
  if (Array.isArray(value)) return (value as unknown[]).map((v, i) => [i, v])
  return Object.keys(value).sort().map((k) => [k, (value as Record<string, unknown>)[k]])
}

function countLabel(value: object): string {
  return Array.isArray(value) ? `[${value.length}]` : `{${Object.keys(value).length}}`
}

// default: only the root row is open; expanded/collapsed: everything is.
type Baseline = 'default' | 'expanded' | 'collapsed'
const ROOT_PATH = ''

interface TreeState {
  baseline: Baseline
  overrides: Map<string, boolean>
  editingPath: string | null
  draft: string
}

function isExpanded(state: TreeState, path: string): boolean {
  const override = state.overrides.get(path)
  if (override !== undefined) return override
  if (state.baseline === 'expanded') return true
  if (state.baseline === 'collapsed') return false
  return path === ROOT_PATH
}

interface NodeContext {
  state: TreeState
  toggle: (path: string, value: unknown) => void
  beginEdit: (path: string, initial: string) => void
  setDraft: (draft: string) => void
  endEdit: () => void
  onCommit?: (path: string, next: unknown, prev: unknown) => void
}

function ValueCell({ path, value, editable, ctx }: {
  path: string
  value: unknown
  editable: boolean
  ctx: NodeContext
}) {
  if (typeof value === 'boolean') {
    return (
      <span className="inline-flex items-center gap-1 text-code-keyword">
        {editable && (
          <input
            type="checkbox"
            checked={value}
            onChange={() => ctx.onCommit?.(path, !value, value)}
            className="accent-accent"
          />
        )}
        {String(value)}
      </span>
    )
  }
  if (value === null || value === undefined) {
    return <span className="text-code-keyword">{String(value)}</span>
  }
  if (ctx.state.editingPath === path) {
    const commit = (): void => {
      const prev = value
      if (typeof prev === 'number') {
        const draft = ctx.state.draft.trim()
        const next = Number(draft)
        ctx.endEdit()
        // Only finite numbers commit: Infinity/-Infinity (and 1e309-style
        // overflow) are not serializable AppData values.
        if (draft === '' || !Number.isFinite(next)) return
        ctx.onCommit?.(path, next, prev)
        return
      }
      const next = ctx.state.draft
      ctx.endEdit()
      ctx.onCommit?.(path, next, prev)
    }
    return (
      <input
        type="text"
        autoFocus
        value={ctx.state.draft}
        onChange={(e) => ctx.setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') ctx.endEdit()
        }}
        onBlur={commit}
        className="bg-surface-3 border border-accent rounded px-1 text-[12px] font-mono min-w-0 w-40"
      />
    )
  }
  const color = typeof value === 'number'
    ? { color: 'var(--color-code-number)' }
    : undefined
  return (
    <span
      data-testid="appdata-value"
      className={typeof value === 'string' ? 'text-code-orange' : undefined}
      style={color}
      onDoubleClick={editable ? () => ctx.beginEdit(path, String(value)) : undefined}
    >
      {String(value)}
    </span>
  )
}

/** True when a key segment would be re-parsed by the runtime's lodash-style
 * `toPath` (dots / brackets), or silently DROPPED by it (empty keys — toPath
 * never pushes an empty segment, so `profile.` parses to just `['profile']`
 * and a write would overwrite the parent). Array indices are numbers and
 * always safe. */
function segmentUnsafe(key: string | number): boolean {
  return typeof key === 'string' && (key === '' || /[.[\]]/.test(key))
}

function TreeNode({ path, label, value, depth, unsafeSegments, ctx }: {
  path: string
  label: string
  value: unknown
  depth: number
  /** Some segment on this node's path (its own key included) contains `.`/`[`/`]`. */
  unsafeSegments: boolean
  ctx: NodeContext
}) {
  const indent = { paddingLeft: depth * 14 }
  if (isContainer(value)) {
    const open = isExpanded(ctx.state, path)
    return (
      <div>
        <div
          className="flex items-center gap-1 px-2 py-px cursor-pointer hover:bg-surface-3 text-[12px] font-mono"
          style={indent}
          onClick={() => ctx.toggle(path, value)}
        >
          <span className="text-text-secondary w-3 shrink-0 text-center select-none">
            {open ? '▾' : '▸'}
          </span>
          <span className="text-code-blue">{label}</span>
          <span className="text-text-secondary">{countLabel(value)}</span>
        </div>
        {open && sortedEntries(value).map(([key, child]) => (
          <TreeNode
            key={String(key)}
            path={childPath(path, key)}
            label={String(key)}
            value={child}
            depth={depth + 1}
            unsafeSegments={unsafeSegments || segmentUnsafe(key)}
            ctx={ctx}
          />
        ))}
      </div>
    )
  }
  const primitive = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
  // A multi-segment path with an unsafe segment cannot round-trip through the
  // runtime's string-path `set()` — the patch key would be re-split on the
  // dots/brackets inside the key and write a DIFFERENT field. A single-segment
  // (top-level) key is safe regardless of content: the runtime's own-key check
  // short-circuits before path parsing. `__proto__` is unwritable at ANY
  // depth: the runtime's isUnsafeProperty drops the write outright. Unsafe
  // rows render read-only.
  const pathAmbiguous = (depth > 1 && unsafeSegments) || label === '__proto__'
  const editable = primitive && ctx.onCommit !== undefined && !pathAmbiguous
  return (
    <div
      className="flex items-center gap-1 px-2 py-px text-[12px] font-mono"
      style={indent}
      {...(editable ? { 'data-path': path } : {})}
    >
      <span className="w-3 shrink-0" />
      <span className="text-code-blue">{label}</span>
      <span className="text-text-secondary">:</span>
      <ValueCell path={path} value={value} editable={editable} ctx={ctx} />
    </div>
  )
}

export function AppDataTree({ root, bridgeId, command, onCommit }: AppDataTreeProps) {
  const [baseline, setBaseline] = useState<Baseline>('default')
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map())
  const [appliedSeq, setAppliedSeq] = useState(0)
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  // Applying a toolbar command during render (state-adjust-in-render, same
  // pattern as useActiveBridgeId) keeps the frame it lands on consistent.
  if (command && command.bridgeId === bridgeId && command.seq !== appliedSeq) {
    setBaseline(command.mode)
    setOverrides(new Map())
    setAppliedSeq(command.seq)
  }

  const state: TreeState = { baseline, overrides, editingPath, draft }
  const ctx: NodeContext = {
    state,
    toggle: (path, value) => {
      const next = new Map(overrides)
      const opening = !isExpanded(state, path)
      next.set(path, opening)
      // Opening an array also opens its container elements: the elements are
      // anonymous index rows, so surfacing their fields in the same click is
      // what makes `list[0].id` reachable without a second dig.
      if (opening && Array.isArray(value)) {
        ;(value as unknown[]).forEach((element, i) => {
          if (isContainer(element)) next.set(childPath(path, i), true)
        })
      }
      setOverrides(next)
    },
    beginEdit: (path, initial) => {
      setEditingPath(path)
      setDraft(initial)
    },
    setDraft,
    endEdit: () => setEditingPath(null),
    onCommit,
  }

  return (
    <div data-testid="appdata-tree" className="py-1">
      <TreeNode path={ROOT_PATH} label="object" value={root} depth={0} unsafeSegments={false} ctx={ctx} />
    </div>
  )
}
