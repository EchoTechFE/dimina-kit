import React from 'react'
import JsonView from '@uiw/react-json-view'
import { Button } from '@/shared/components/ui/button'
import type { AppDataState } from '../project-runtime/controllers/use-panel-data'

function bridgeLabel(bridge: { id: string; pagePath: string | null }): string {
  return bridge.pagePath ?? bridge.id
}

// Map the json-view CSS vars onto the panel's existing design tokens so the
// component blends with both dark and light themes. CSS variables defined
// here cascade to the json-view's internal vars (--w-rjv-*) via inline style.
const JSON_VIEW_STYLE: React.CSSProperties = {
  '--w-rjv-font-family': 'var(--font-family-mono)',
  '--w-rjv-background-color': 'transparent',
  '--w-rjv-color': 'var(--color-code-blue)',
  '--w-rjv-key-string': 'var(--color-code-blue)',
  '--w-rjv-line-color': 'var(--color-border-subtle)',
  '--w-rjv-arrow-color': 'var(--color-text-secondary)',
  '--w-rjv-info-color': 'var(--color-code-label)',
  '--w-rjv-curlybraces-color': 'var(--color-text-secondary)',
  '--w-rjv-brackets-color': 'var(--color-text-secondary)',
  '--w-rjv-quotes-color': 'var(--color-code-orange)',
  '--w-rjv-quotes-string-color': 'var(--color-code-orange)',
  '--w-rjv-type-string-color': 'var(--color-code-orange)',
  '--w-rjv-type-int-color': 'var(--color-code-number)',
  '--w-rjv-type-float-color': 'var(--color-code-number)',
  '--w-rjv-type-bigint-color': 'var(--color-code-number)',
  '--w-rjv-type-boolean-color': 'var(--color-code-keyword)',
  '--w-rjv-type-null-color': 'var(--color-code-keyword)',
  '--w-rjv-type-nan-color': 'var(--color-code-keyword)',
  '--w-rjv-type-undefined-color': 'var(--color-code-keyword)',
  '--w-rjv-type-date-color': 'var(--color-code-label)',
  '--w-rjv-type-url-color': 'var(--color-code-blue)',
  fontSize: 12,
  padding: '6px 8px',
  wordBreak: 'break-all',
  whiteSpace: 'pre-wrap',
} as React.CSSProperties

export function AppDataPanel({
  state,
  onRefresh,
  onSelectBridge,
}: {
  state: AppDataState
  onRefresh: () => void
  onSelectBridge: (id: string) => void
}) {
  const { bridges, activeBridgeId, entries } = state
  const active = activeBridgeId && bridges.some((b) => b.id === activeBridgeId)
    ? activeBridgeId
    : bridges.at(-1)?.id ?? null
  const anyEntries = bridges.some((b) => Object.keys(entries[b.id] ?? {}).length > 0)
  return (
    <div className="flex flex-col overflow-hidden flex-1">
      <div className="flex items-center px-2.5 py-1.5 border-b border-border-subtle shrink-0 bg-bg-panel">
        <Button
          variant="outline"
          size="xs"
          onClick={onRefresh}
          className="hover:border-accent hover:text-accent"
        >
          ↻ 刷新
        </Button>
      </div>
      {bridges.length > 1 && (
        <div className="flex gap-1 px-2 py-1 border-b border-border-subtle shrink-0 overflow-x-auto bg-bg-panel">
          {bridges.map((b) => {
            const isActive = b.id === active
            return (
              <button
                key={b.id}
                onClick={() => onSelectBridge(b.id)}
                title={b.id}
                className={
                  'shrink-0 px-2 py-0.5 text-[11px] rounded border transition-colors '
                  + (isActive
                    ? 'border-accent text-accent bg-surface-3'
                    : 'border-border-subtle text-text-dim hover:border-accent hover:text-accent')
                }
              >
                {bridgeLabel(b)}
              </button>
            )
          })}
        </div>
      )}
      {bridges.length === 0 || !anyEntries ? (
        <div className="text-[12px] text-text-dim text-center px-4 py-6">
          暂无页面数据（仅显示 Page 级 data）
        </div>
      ) : (
        // Keepalive: render every bridge's entries; hide non-active ones via
        // `display: none` so the JsonView instances stay mounted and preserve
        // their expand/collapse state across tab switches.
        <div className="flex-1 overflow-hidden relative">
          {bridges.map((b) => {
            const isActive = b.id === active
            const bridgeEntries = entries[b.id] ?? {}
            const keys = Object.keys(bridgeEntries)
            return (
              <div
                key={b.id}
                className="absolute inset-0 flex flex-col gap-2 p-2 overflow-y-auto"
                style={{ display: isActive ? 'flex' : 'none' }}
              >
                {keys.length === 0 ? (
                  <div className="text-[12px] text-text-dim text-center px-4 py-6">
                    暂无页面数据（仅显示 Page 级 data）
                  </div>
                ) : (
                  keys.map((comp) => (
                    <div
                      key={`${b.id}::${comp}`}
                      className="border border-border-subtle rounded overflow-hidden shrink-0"
                    >
                      <div className="bg-surface-3 px-2 py-0.5 text-[11px] text-code-label truncate">
                        {comp}
                      </div>
                      <JsonView
                        value={(bridgeEntries[comp] ?? {}) as object}
                        collapsed={1}
                        displayDataTypes={false}
                        displayObjectSize={false}
                        enableClipboard={false}
                        indentWidth={12}
                        style={JSON_VIEW_STYLE}
                      />
                    </div>
                  ))
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
