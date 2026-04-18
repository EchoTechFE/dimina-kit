import React from 'react'
import { Button } from '@/shared/components/ui/button'

export function AppDataPanel({
  data,
  onRefresh,
}: {
  data: Record<string, unknown>
  onRefresh: () => void
}) {
  const keys = Object.keys(data)
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
      {keys.length === 0 ? (
        <div className="text-[12px] text-text-dim text-center px-4 py-6">
          暂无数据（需小程序触发 setData）
        </div>
      ) : (
        <div className="flex flex-col gap-2 p-2 overflow-y-auto flex-1">
          {keys.map((comp) => (
            <div
              key={comp}
              className="border border-border-subtle rounded overflow-hidden shrink-0"
            >
              <div className="bg-surface-3 px-2 py-0.5 text-[11px] text-code-label truncate">
                {comp}
              </div>
              <pre className="px-2 py-1.5 text-[12px] font-mono text-code-blue whitespace-pre-wrap break-all">
                {JSON.stringify(data[comp], null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
