import React from 'react'
import { Button } from '@/shared/components/ui/button'

export function StoragePanel({
  items,
  onRefresh,
}: {
  items: Array<{ key: string; value: unknown }>
  onRefresh: () => void
}) {
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
      <div className="flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="text-[12px] text-text-dim text-center px-4 py-6">
            暂无 Storage 数据
          </div>
        ) : (
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr>
                <th className="text-left text-code-label font-normal px-2.5 py-1 border-b border-border-subtle text-[11px] sticky top-0 bg-bg z-10">
                  Key
                </th>
                <th className="text-left text-code-label font-normal px-2.5 py-1 border-b border-border-subtle text-[11px] sticky top-0 bg-bg z-10">
                  Value
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map(({ key, value }) => (
                <tr key={key} className="hover:[&>td]:bg-surface">
                  <td className="px-2.5 py-0.5 border-b border-border-subtle font-mono text-code-blue whitespace-nowrap w-px pr-5 align-top">
                    {key}
                  </td>
                  <td className="px-2.5 py-0.5 border-b border-border-subtle font-mono text-code-orange break-all align-top">
                    {typeof value === 'object'
                      ? JSON.stringify(value)
                      : String(value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
