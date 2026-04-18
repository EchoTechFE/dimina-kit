import React, { useMemo, useState, useCallback } from 'react'
import JsonView from '@uiw/react-json-view'
import { darkTheme } from '@uiw/react-json-view/dark'
import { cn } from '@/shared/lib/utils'

export interface JsonViewerProps {
  /** The JSON data to display. */
  data: Record<string, unknown> | unknown[] | null | undefined
  /** Label shown above the viewer. */
  label?: string
  /** Initial collapse depth. 0 = all collapsed, Infinity = all expanded. Default 2. */
  initialDepth?: number
  /** Enable the search / filter input. Default true. */
  searchable?: boolean
  /** Show the object path tooltip on hover. Default true. */
  showPath?: boolean
  /** Additional CSS class names for the outer wrapper. */
  className?: string
}

/**
 * Custom dark theme that integrates with the workbench design tokens.
 * Extends the base dark theme from @uiw/react-json-view.
 */
const workbenchTheme: React.CSSProperties = {
  ...darkTheme,
  '--w-rjv-font-family': 'var(--font-family-mono)',
  '--w-rjv-background-color': 'var(--color-surface)',
  '--w-rjv-color': 'var(--color-text)',
  '--w-rjv-key-string': 'var(--color-code-blue)',
  '--w-rjv-info-color': 'var(--color-text-muted)',
  '--w-rjv-type-string-color': 'var(--color-code-orange)',
  '--w-rjv-type-int-color': 'var(--color-code-number)',
  '--w-rjv-type-float-color': 'var(--color-code-number)',
  '--w-rjv-type-boolean-color': 'var(--color-code-keyword)',
  '--w-rjv-type-null-color': 'var(--color-code-keyword)',
  '--w-rjv-type-undefined-color': 'var(--color-text-dim)',
  '--w-rjv-curlybraces-color': 'var(--color-text-secondary)',
  '--w-rjv-brackets-color': 'var(--color-text-secondary)',
  '--w-rjv-colon-color': 'var(--color-text-muted)',
  '--w-rjv-ellipsis-color': 'var(--color-text-dim)',
  '--w-rjv-arrow-color': 'var(--color-text-muted)',
  '--w-rjv-line-color': 'var(--color-border-subtle)',
} as React.CSSProperties

/**
 * Filter a JSON value recursively, keeping only branches whose keys or
 * stringified primitive values contain the query (case-insensitive).
 */
function filterJson(value: unknown, query: string): unknown {
  if (value === null || value === undefined) return undefined
  const lowerQuery = query.toLowerCase()

  if (Array.isArray(value)) {
    const filtered = value
      .map((item) => filterJson(item, query))
      .filter((item) => item !== undefined)
    return filtered.length > 0 ? filtered : undefined
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    let hasMatch = false
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (key.toLowerCase().includes(lowerQuery)) {
        result[key] = val
        hasMatch = true
      } else {
        const filteredVal = filterJson(val, query)
        if (filteredVal !== undefined) {
          result[key] = filteredVal
          hasMatch = true
        }
      }
    }
    return hasMatch ? result : undefined
  }

  // Primitive: check stringified value
  if (String(value).toLowerCase().includes(lowerQuery)) {
    return value
  }
  return undefined
}

/**
 * Reusable JSON viewer component for workbench panels (AppData, Storage, etc.).
 *
 * Wraps `@uiw/react-json-view` with a dark theme consistent with the workbench
 * design system, optional search/filter, and path display on hover.
 */
export function JsonViewer({
  data,
  label,
  initialDepth = 2,
  searchable = true,
  showPath = true,
  className,
}: JsonViewerProps) {
  const [query, setQuery] = useState('')

  const displayData = useMemo(() => {
    if (!data) return {}
    if (!query.trim()) return data
    const result = filterJson(data, query.trim())
    return (result as Record<string, unknown>) ?? {}
  }, [data, query])

  const handleQueryChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value),
    []
  )

  const isEmpty =
    displayData === null ||
    displayData === undefined ||
    (typeof displayData === 'object' && Object.keys(displayData as object).length === 0)

  return (
    <div className={cn('flex flex-col h-full overflow-hidden', className)}>
      {/* Header bar with optional label and search */}
      {(label || searchable) && (
        <div className="flex items-center gap-2 px-2 py-1.5 bg-surface-2 border-b border-border shrink-0">
          {label && (
            <span className="text-[11px] font-medium text-text-secondary select-none whitespace-nowrap">
              {label}
            </span>
          )}
          {searchable && (
            <input
              type="text"
              value={query}
              onChange={handleQueryChange}
              placeholder="Filter..."
              className={cn(
                'flex-1 min-w-0',
                'bg-surface border border-border text-text placeholder-text-dim',
                'px-1.5 py-0.5 rounded text-[11px] font-mono',
                'focus:outline-none focus:border-accent'
              )}
            />
          )}
        </div>
      )}

      {/* JSON tree */}
      <div className="flex-1 overflow-auto p-1">
        {isEmpty ? (
          <div className="flex items-center justify-center h-full text-text-dim text-[12px] select-none">
            {query.trim() ? 'No matching results' : 'No data'}
          </div>
        ) : (
          <JsonView
            value={displayData as object}
            style={workbenchTheme}
            collapsed={initialDepth}
            displayDataTypes={false}
            displayObjectSize
            enableClipboard
            shortenTextAfterLength={120}
            {...(showPath ? { objectSortKeys: false } : {})}
          />
        )}
      </div>
    </div>
  )
}

export default JsonViewer
