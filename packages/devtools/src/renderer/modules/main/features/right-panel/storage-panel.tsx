import React, { useEffect, useState } from 'react'
import { Button } from '@/shared/components/ui/button'
import type { StorageWriteResult } from '../../../../../shared/ipc-channels'

interface StorageItem { key: string; value: unknown }

export interface StoragePanelProps {
  items: StorageItem[]
  onRefresh: () => void
  onSet: (key: string, value: string) => Promise<StorageWriteResult>
  onRemove: (key: string) => Promise<StorageWriteResult>
  onClear: () => Promise<StorageWriteResult>
  onClearAll: () => Promise<StorageWriteResult>
  getPrefix: () => Promise<string>
}

/** Stringifies arbitrary StorageItem values for editing in a text input. */
function toEditableString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    try { return JSON.stringify(value) } catch { return String(value) }
  }
  return String(value)
}

export function StoragePanel({
  items,
  onRefresh,
  onSet,
  onRemove,
  onClear,
  onClearAll,
  getPrefix,
}: StoragePanelProps) {
  const [editing, setEditing] = useState<{ key: string; draft: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [prefix, setPrefix] = useState('')
  const [addKey, setAddKey] = useState('')
  const [addValue, setAddValue] = useState('')

  useEffect(() => {
    let cancelled = false
    void getPrefix().then((p) => { if (!cancelled) setPrefix(p) })
    return () => { cancelled = true }
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
    setEditing({ key: item.key, draft: toEditableString(item.value) })
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
    // Origin-wide wipe affects every project's keys in the shared simulator
    // partition. Use `window.confirm` so the user has to opt in explicitly.
    if (typeof window !== 'undefined' && !window.confirm('清空 simulator 中所有 appId 的 Storage 数据？该操作不可撤销。')) return
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
        <Button
          variant="outline"
          size="xs"
          onClick={onRefresh}
          disabled={busy}
          className="hover:border-accent hover:text-accent"
        >
          ↻ 刷新
        </Button>
        <Button
          variant="outline"
          size="xs"
          onClick={handleClear}
          disabled={busy || items.length === 0}
          className="hover:border-destructive hover:text-destructive"
          title="仅清空当前 appId 的 Storage"
        >
          清空
        </Button>
        <Button
          variant="outline"
          size="xs"
          onClick={handleClearAll}
          disabled={busy}
          className="hover:border-destructive hover:text-destructive"
          title="清空 simulator 中所有 appId 的 Storage"
        >
          清空所有
        </Button>
        {error && (
          <span className="ml-2 text-[11px] text-destructive truncate" title={error}>
            {error}
          </span>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr>
              <th className="text-left text-code-label font-normal px-2.5 py-1 border-b border-border-subtle text-[11px] sticky top-0 bg-bg z-10">
                Key
              </th>
              <th className="text-left text-code-label font-normal px-2.5 py-1 border-b border-border-subtle text-[11px] sticky top-0 bg-bg z-10">
                Value
              </th>
              <th className="w-px sticky top-0 bg-bg z-10 border-b border-border-subtle" />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={3} className="text-[12px] text-text-dim text-center px-4 py-6">
                  暂无 Storage 数据
                </td>
              </tr>
            ) : items.map((item) => {
              const isEditing = editing?.key === item.key
              return (
                <tr key={item.key} className="hover:[&>td]:bg-surface">
                  <td className="px-2.5 py-0.5 border-b border-border-subtle font-mono text-code-blue whitespace-nowrap w-px pr-5 align-top">
                    {item.key}
                  </td>
                  <td
                    className="px-2.5 py-0.5 border-b border-border-subtle font-mono text-code-orange break-all align-top cursor-text"
                    onClick={() => { if (!isEditing) startEdit(item) }}
                  >
                    {isEditing ? (
                      <input
                        autoFocus
                        type="text"
                        value={editing!.draft}
                        onChange={(e) => setEditing({ key: item.key, draft: e.target.value })}
                        onBlur={commitEdit}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); commitEdit() }
                          else if (e.key === 'Escape') { e.preventDefault(); setEditing(null) }
                        }}
                        className="w-full bg-transparent outline-none border border-accent/60 rounded px-1 py-0 font-mono text-code-orange"
                      />
                    ) : (
                      toEditableString(item.value)
                    )}
                  </td>
                  <td className="px-1 py-0.5 border-b border-border-subtle align-top">
                    <button
                      type="button"
                      onClick={() => handleRemove(item.key)}
                      disabled={busy}
                      title="删除"
                      className="text-text-dim hover:text-destructive px-1 leading-none"
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
        {prefix && (
          <span className="font-mono text-[11px] text-text-dim shrink-0" title="active appId prefix">
            {prefix}
          </span>
        )}
        <input
          type="text"
          placeholder="key"
          value={addKey}
          onChange={(e) => setAddKey(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleAdd() } }}
          className="w-32 bg-transparent border border-border-subtle rounded px-1.5 py-0.5 text-[12px] font-mono outline-none focus:border-accent"
        />
        <input
          type="text"
          placeholder="value"
          value={addValue}
          onChange={(e) => setAddValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleAdd() } }}
          className="flex-1 bg-transparent border border-border-subtle rounded px-1.5 py-0.5 text-[12px] font-mono outline-none focus:border-accent"
        />
        <Button
          variant="outline"
          size="xs"
          onClick={() => void handleAdd()}
          disabled={busy || !addKey.trim()}
          className="hover:border-accent hover:text-accent"
        >
          + 新增
        </Button>
      </div>
    </div>
  )
}
