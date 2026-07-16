// The pure AppData panel view: per-page bridge tabs over cumulative setData
// state, each component path rendered as a collapsible JSON tree. Pure
// presentation — bridge selection and data feeds live in the connected
// container (or the host, when it renders this view directly).
import React from 'react'
import * as jsonViewModule from '@uiw/react-json-view'
import type { AppDataSnapshot } from './appdata-accumulator.js'

// The package ships CJS-flavoured type declarations (no `"type": "module"`),
// so what `default` types as depends on the consumer's moduleResolution:
// under NodeNext it is the whole module.exports object with the component on
// `.default`; under Bundler (and in vite/vitest at runtime) it IS the
// component (a forwardRef exotic object, so a typeof-function probe can't
// tell the shapes apart; the interop namespace is the only shape carrying a
// `default` key). The conditional type and the `in` probe resolve the
// component under BOTH semantics — this package typechecks under NodeNext
// and is also typechecked from source by Bundler-resolution consumers.
type ModuleDefault = (typeof jsonViewModule)['default']
type JsonViewComponent = ModuleDefault extends { default: infer C } ? C : ModuleDefault
const moduleDefault: JsonViewComponent | { default: JsonViewComponent } = jsonViewModule.default
// A type predicate (not a bare `in` check): plain `in` narrowing intersects
// `Record<'default', unknown>` onto the component branch, degrading the
// conditional's type to unknown.
function isInteropNamespace(
  m: JsonViewComponent | { default: JsonViewComponent },
): m is { default: JsonViewComponent } {
  return 'default' in m
}
const JsonView: JsonViewComponent
  = isInteropNamespace(moduleDefault) ? moduleDefault.default : moduleDefault

/** The view's full input state: a snapshot plus which bridge tab is active. */
export interface AppDataPanelState {
  bridges: AppDataSnapshot['bridges']
  activeBridgeId: string | null
  entries: AppDataSnapshot['entries']
}

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

export interface AppDataPanelProps {
  state: AppDataPanelState
  onSelectBridge: (id: string) => void
  /** Whether the mini-program's runtime session is `running` — distinguishes "小程序未运行" from a true empty-data vacuum below. Defaults to true so callers that don't track runtime status keep the plain empty-data text. */
  isRuntimeRunning?: boolean
}

export function AppDataPanel({
  state,
  onSelectBridge,
  isRuntimeRunning = true,
}: AppDataPanelProps) {
  const { bridges, activeBridgeId, entries } = state
  return (
    <div className="flex flex-col overflow-hidden flex-1" data-testid="appdata-panel">
      {bridges.length > 1 && (
        <div className="flex gap-1 px-2 py-1 border-b border-border-subtle shrink-0 overflow-x-auto bg-bg-panel">
          {bridges.map((b) => {
            const isActive = b.id === activeBridgeId
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
      {bridges.length === 0 ? (
        <div className="text-[12px] text-text-dim text-center px-4 py-6">
          {isRuntimeRunning ? '暂无页面数据（仅显示 Page 级 data）' : '小程序未运行'}
        </div>
      ) : (
        // A bridge with zero entries still gets its keepalive container (with
        // the per-bridge empty text) so live pushes land in a mounted tab.
        // Keepalive: render every bridge's entries; hide non-active ones via
        // `display: none` so the JsonView instances stay mounted and preserve
        // their expand/collapse state across tab switches.
        <div className="flex-1 overflow-hidden relative">
          {bridges.map((b) => {
            const isActive = b.id === activeBridgeId
            const bridgeEntries = entries[b.id] ?? {}
            const keys = Object.keys(bridgeEntries)
            return (
              <div
                key={b.id}
                data-bridge-id={b.id}
                className="absolute inset-0 flex flex-col gap-2 p-2 overflow-y-auto"
                style={{ display: isActive ? 'flex' : 'none' }}
              >
                {keys.length === 0 ? (
                  <div className="text-[12px] text-text-dim text-center px-4 py-6">
                    {isRuntimeRunning ? '暂无页面数据（仅显示 Page 级 data）' : '小程序未运行'}
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
