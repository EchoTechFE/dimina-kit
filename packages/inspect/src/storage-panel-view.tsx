// The pure Storage table view: items in, write callbacks out. No data
// wiring lives here (seed/subscribe/visibility belong to
// ConnectedStoragePanel); no host UI kit either — the couple of buttons are
// plain elements styled with the same Tailwind utility tokens as the rest of
// the panel, so any host that maps the CSS variables gets the native look.
import React, { useEffect, useState } from 'react'
import type { StorageItem, StorageWriteResult } from './storage-types.js'

export interface StoragePanelProps {
  items: StorageItem[]
  onSet: (key: string, value: string) => Promise<StorageWriteResult>
  onRemove: (key: string) => Promise<StorageWriteResult>
  onClear: () => Promise<StorageWriteResult>
  /** Origin-wide wipe across every appId. Hosts whose localStorage is shared
   * with non-mini-program data (e.g. a browser workbench living on the same
   * origin) must omit it; the「清空所有」button then never renders. */
  onClearAll?: () => Promise<StorageWriteResult>
  getPrefix: () => Promise<string>
  /** Whether the mini-program's runtime session is running — distinguishes
   * "小程序未运行" from a true empty-data vacuum below. Defaults to true so
   * callers that don't track runtime status keep the plain empty-data text. */
  isRuntimeRunning?: boolean
}

const BUTTON_CLASS
  = 'inline-flex items-center justify-center gap-1.5 font-medium transition-colors '
    + 'focus:outline-none disabled:opacity-35 disabled:cursor-not-allowed whitespace-nowrap shrink-0 '
    + 'border border-border text-text-muted hover:text-text rounded h-5 px-2 text-[11px]'

export function StoragePanel({
  items,
  onSet,
  onRemove,
  onClear,
  onClearAll,
  getPrefix,
  isRuntimeRunning = true,
}: StoragePanelProps) {
  const [editing, setEditing] = useState<{ key: string, draft: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [prefix, setPrefix] = useState('')
  const [addKey, setAddKey] = useState('')
  const [addValue, setAddValue] = useState('')

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // The panel can mount before the host has resolved the active appId, so
    // `getPrefix()` initially returns '' and the key un-prefixing below would
    // never engage. The prefix is empty only transiently during session
    // warmup, so poll until it resolves non-empty (then stop). Once set it is
    // stable for the session's lifetime.
    const load = () => {
      void getPrefix().then((p) => {
        if (cancelled) return
        if (p) { setPrefix(p); return }
        timer = setTimeout(load, 300)
      })
    }
    load()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [getPrefix])

  async function withBusy<T extends StorageWriteResult>(op: () => Promise<T>): Promise<T | null> {
    setBusy(true)
    setError(null)
    try {
      const r = await op()
      if (!r.ok) { setError(r.error); return null }
      return r
    } finally {
      setBusy(false)
    }
  }

  function startEdit(item: StorageItem) {
    setEditing({ key: item.key, draft: item.value })
  }

  async function commitEdit() {
    if (!editing) return
    const { key, draft } = editing
    setEditing(null)
    await withBusy(() => onSet(key, draft))
  }

  async function handleRemove(key: string) {
    await withBusy(() => onRemove(key))
  }

  async function handleClear() {
    if (items.length === 0) return
    await withBusy(() => onClear())
  }

  async function handleClearAll() {
    if (!onClearAll) return
    // Origin-wide wipe affects every appId's keys in the shared storage
    // partition. Use `window.confirm` so the user has to opt in explicitly.
    if (typeof window !== 'undefined' && !window.confirm('清空所有 appId 的 Storage 数据？该操作不可撤销。')) return
    await withBusy(() => onClearAll())
  }

  async function handleAdd() {
    const trimmedKey = addKey.trim()
    if (!trimmedKey) { setError('key 不能为空'); return }
    const fullKey = prefix + trimmedKey
    const r = await withBusy(() => onSet(fullKey, addValue))
    if (r) {
      setAddKey('')
      setAddValue('')
    }
  }

  return (
    <div className="flex flex-col overflow-hidden flex-1" data-testid="storage-panel">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-border-subtle shrink-0 bg-bg-panel">
        <button
          type="button"
          onClick={() => void handleClear()}
          disabled={busy || items.length === 0}
          className={`${BUTTON_CLASS} hover:border-status-error hover:text-status-error`}
          title="仅清空当前 appId 的 Storage"
        >
          清空
        </button>
        {onClearAll && (
          <button
            type="button"
            onClick={() => void handleClearAll()}
            disabled={busy}
            className={`${BUTTON_CLASS} hover:border-status-error hover:text-status-error`}
            title="清空所有 appId 的 Storage"
          >
            清空所有
          </button>
        )}
        {error && (
          <span className="ml-2 text-[11px] text-status-error truncate" title={error}>
            {error}
          </span>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr>
              <th className="text-left text-code-label font-normal px-2.5 py-1 border-b border-border-subtle text-[11px] sticky top-0 bg-bg-panel z-10 w-px pr-5">
                Key
              </th>
              <th className="text-left text-code-label font-normal px-2.5 py-1 border-b border-border-subtle text-[11px] sticky top-0 bg-bg-panel z-10">
                Value
              </th>
              <th className="w-px sticky top-0 bg-bg-panel z-10 border-b border-border-subtle" />
            </tr>
          </thead>
          <tbody>
            {items.length === 0
              ? (
                  <tr>
                    <td colSpan={3} className="text-[12px] text-text-dim text-center px-4 py-6">
                      {isRuntimeRunning ? '暂无 Storage 数据' : '小程序未运行'}
                    </td>
                  </tr>
                )
              : items.map((item) => {
                  const isEditing = editing?.key === item.key
                  // Display keys without the active appId namespace prefix
                  // (`${appId}_`), the way Chrome's Local Storage panel shows
                  // clean keys. The full key (used for every read/write below)
                  // stays in the `title` for discoverability.
                  const displayKey = prefix && item.key.startsWith(prefix)
                    ? item.key.slice(prefix.length)
                    : item.key
                  return (
                    <tr key={item.key} className="hover:[&>td]:bg-surface">
                      <td className="px-2.5 py-0.5 border-b border-border-subtle w-px pr-5 align-top">
                        <div className="font-mono text-code-blue max-w-[240px] truncate" title={item.key}>
                          {displayKey}
                        </div>
                      </td>
                      <td
                        className="px-2.5 py-0.5 border-b border-border-subtle font-mono text-code-orange break-all align-top cursor-text"
                        onClick={() => { if (!isEditing) startEdit(item) }}
                      >
                        {isEditing
                          ? (
                              <input
                                autoFocus
                                type="text"
                                value={editing.draft}
                                onChange={e => setEditing({ key: item.key, draft: e.target.value })}
                                onBlur={() => void commitEdit()}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') { e.preventDefault(); void commitEdit() }
                                  else if (e.key === 'Escape') { e.preventDefault(); setEditing(null) }
                                }}
                                className="w-full bg-transparent outline-none border border-accent/60 rounded px-1 py-0 font-mono text-code-orange"
                              />
                            )
                          : item.value}
                      </td>
                      <td className="px-1 py-0.5 border-b border-border-subtle align-top">
                        <button
                          type="button"
                          onClick={() => void handleRemove(item.key)}
                          disabled={busy}
                          title="删除"
                          className="text-text-dim hover:text-status-error px-1 leading-none"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  )
                })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-border-subtle shrink-0 bg-bg-panel">
        {/* New keys are auto-namespaced with the active appId prefix (see
            handleAdd); the raw prefix is intentionally not shown — Chrome's
            Local Storage panel likewise hides the storage-key namespace. */}
        <input
          type="text"
          placeholder="key"
          value={addKey}
          onChange={e => setAddKey(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleAdd() } }}
          className="w-32 bg-transparent border border-border-subtle rounded px-1.5 py-0.5 text-[12px] font-mono outline-none focus:border-accent"
        />
        <input
          type="text"
          placeholder="value"
          value={addValue}
          onChange={e => setAddValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleAdd() } }}
          className="flex-1 bg-transparent border border-border-subtle rounded px-1.5 py-0.5 text-[12px] font-mono outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={busy || !addKey.trim()}
          className={`${BUTTON_CLASS} hover:border-accent hover:text-accent`}
        >
          + 新增
        </button>
      </div>
    </div>
  )
}
