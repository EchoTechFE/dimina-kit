import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/components/ui/button'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VirtualListProps<T> {
  /** The full list of items to render. */
  items: T[]
  /**
   * Render callback for a single item.
   * `measureRef` **must** be forwarded to the outermost DOM element of the row
   * so that the virtualizer can measure its actual height.
   */
  renderItem: (item: T, index: number, measureRef: (el: HTMLElement | null) => void) => React.ReactNode
  /**
   * Estimated height (px) for rows before they are measured.
   * A reasonable guess avoids large layout jumps.
   * @default 28
   */
  estimateSize?: number
  /**
   * Number of rows rendered beyond the visible viewport (on each side).
   * Higher values reduce blank flashes during fast scrolling.
   * @default 10
   */
  overscan?: number
  /**
   * When `true`, the list automatically scrolls to the bottom whenever `items`
   * changes — unless the user has scrolled away from the bottom.
   * @default true
   */
  autoScrollToBottom?: boolean
  /**
   * Distance (px) from the bottom within which the list is considered
   * "at the bottom" for auto-scroll purposes.
   * @default 40
   */
  bottomThreshold?: number
  /** Extra className applied to the outer scroll container. */
  className?: string
  /** Stable key extractor. Falls back to the array index when omitted. */
  getItemKey?: (index: number) => React.Key
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VirtualList<T>({
  items,
  renderItem,
  estimateSize = 28,
  overscan = 10,
  autoScrollToBottom = true,
  bottomThreshold = 40,
  className,
  getItemKey,
}: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [showScrollBtn, setShowScrollBtn] = useState(false)

  // ---- virtualizer ----------------------------------------------------------

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan,
    getItemKey,
  })

  // ---- scroll tracking ------------------------------------------------------

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = distanceFromBottom <= bottomThreshold
    setIsAtBottom(atBottom)
    setShowScrollBtn(!atBottom)
  }, [bottomThreshold])

  // ---- auto-scroll on new items --------------------------------------------

  const prevCountRef = useRef(items.length)
  useEffect(() => {
    if (!autoScrollToBottom) return
    if (items.length !== prevCountRef.current && isAtBottom) {
      virtualizer.scrollToIndex(items.length - 1, { align: 'end', behavior: 'smooth' })
    }
    prevCountRef.current = items.length
  }, [items.length, autoScrollToBottom, isAtBottom, virtualizer])

  // ---- manual scroll-to-bottom button --------------------------------------

  const scrollToBottom = useCallback(() => {
    if (items.length === 0) return
    virtualizer.scrollToIndex(items.length - 1, { align: 'end', behavior: 'smooth' })
    setIsAtBottom(true)
    setShowScrollBtn(false)
  }, [items.length, virtualizer])

  // ---- render ---------------------------------------------------------------

  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div className={cn('relative h-full w-full', className)}>
      {/* scrollable viewport */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full w-full overflow-auto"
      >
        {/* total-size spacer */}
        <div
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {/* positioned rows */}
          {virtualItems.map((virtualRow) => {
            const item = items[virtualRow.index]
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                className="absolute left-0 top-0 w-full"
                style={{
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {renderItem(
                  item,
                  virtualRow.index,
                  virtualizer.measureElement,
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* scroll-to-bottom button */}
      {showScrollBtn && (
        <Button
          variant="ghost"
          size="sm"
          onClick={scrollToBottom}
          className={cn(
            'absolute bottom-3 left-1/2 -translate-x-1/2',
            'flex items-center gap-1 rounded-full px-3 py-1',
            'bg-surface-3 text-text-secondary text-[12px]',
            'border border-border hover:bg-surface-active hover:text-text',
            'shadow-md transition-colors cursor-pointer',
          )}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
          Scroll to bottom
        </Button>
      )}
    </div>
  )
}
