import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/shared/lib/utils'
import type {
  CompileEvent,
  CompileLogEntry,
} from '../project-runtime/controllers/use-session.js'

export interface CompilePanelProps {
  /** Chronological (oldest-first) compile-event log from useSession. */
  events: CompileEvent[]
  /**
   * Chronological (oldest-first) per-line dmcc log. Optional: omitting it
   * keeps the event-only behaviour (incl. the 暂无编译 empty state).
   */
  logs?: CompileLogEntry[]
  /** Clear the log (drives useSession.clearCompileEvents — both stores). */
  onClear: () => void
}

function formatTime(at: number): string {
  const d = new Date(at)
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}

/** Status → row/badge accent. Unknown statuses fall back to muted text. */
function statusClass(status: string): string {
  if (status === 'error') return 'text-red-500'
  if (status === 'compiling') return 'text-amber-500'
  if (status === 'ready') return 'text-emerald-600'
  return 'text-text-muted'
}

/** Extract the display text from a timeline item for filter matching. */
function itemText(item: TimelineItem): string {
  return item.kind === 'event' ? item.event.message : item.log.text
}

interface EventItem {
  kind: 'event'
  at: number
  /** Arrival counter shared with logs — the same-`at` tie-break carrier. */
  seq?: number
  event: CompileEvent
  /** Elapsed ms when this ready event pairs with the preceding compiling. */
  durationMs: number | null
}

interface LogItem {
  kind: 'log'
  at: number
  /** Arrival counter shared with events — the same-`at` tie-break carrier. */
  seq?: number
  log: CompileLogEntry
}

type TimelineItem = EventItem | LogItem

/**
 * 编译 tab body: the compile-event log (projectStatus traffic) and the
 * per-line dmcc compile log merged — in the VIEW layer only — into one
 * oldest-first (chronological) timeline with a text filter. State stays
 * isolated in useSession.
 */
export function CompilePanel({ events, logs = [], onClear }: CompilePanelProps) {
  const latest = events.length > 0 ? events[events.length - 1]! : null
  const [filter, setFilter] = useState('')

  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const shouldAutoScroll = useRef(true)

  // Track whether the user has scrolled away from the bottom.
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container
      shouldAutoScroll.current = scrollHeight - scrollTop - clientHeight < 30
    }
    container.addEventListener('scroll', handleScroll)
    return () => container.removeEventListener('scroll', handleScroll)
  }, [])

  const totalItems = events.length + logs.length

  // Auto-scroll to bottom when new items arrive.
  useEffect(() => {
    if (shouldAutoScroll.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' })
    }
  }, [totalItems])

  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = []
    events.forEach((event, index) => {
      // Duration pairs strictly with the IMMEDIATELY preceding event: a
      // ready right after a compiling shows the elapsed compile time; any
      // intervening event (e.g. an error) breaks the pair.
      const previous = index > 0 ? events[index - 1]! : null
      const durationMs =
        event.status === 'ready' && previous?.status === 'compiling'
          ? event.at - previous.at
          : null
      items.push({ kind: 'event', at: event.at, seq: event.seq, event, durationMs })
    })
    for (const log of logs) {
      items.push({ kind: 'log', at: log.at, seq: log.seq, log })
    }
    // Newest first (reverse-chronological). Within a same-`at` tie
    // (millisecond stamps — an event and the logs of the same compile collide
    // routinely) the shared monotonic `seq` keeps ARRIVAL order.
    return items.sort((a, b) => {
      if (a.at !== b.at) return b.at - a.at
      if (a.seq !== undefined && b.seq !== undefined) return a.seq - b.seq
      return 0
    })
  }, [events, logs])

  const filtered = useMemo(() => {
    if (!filter) return timeline
    const lower = filter.toLowerCase()
    return timeline.filter((item) => itemText(item).toLowerCase().includes(lower))
  }, [timeline, filter])

  const isEmpty = events.length === 0 && logs.length === 0

  return (
    <div className="flex flex-col h-full w-full min-h-0 text-[12px]">
      {/* Header: current-status badge + filter + 清空. */}
      <div className="flex items-center gap-2 px-2 h-8 shrink-0 border-b border-border-subtle">
        {latest ? (
          <span
            data-compile-current
            data-status={latest.status}
            className={cn('truncate font-medium shrink-0', statusClass(latest.status))}
          >
            {latest.message}
          </span>
        ) : (
          <span className="text-text-muted shrink-0">编译信息</span>
        )}
        <div className="flex-1 min-w-0" />
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="过滤..."
          className="h-6 px-2 text-[12px] rounded-sm border border-border-subtle bg-surface
                     text-text placeholder:text-text-dim
                     focus:outline-none focus:border-text-muted
                     w-40 shrink-0"
        />
        {filter && (
          <span className="text-[11px] text-text-muted tabular-nums shrink-0">
            {filtered.length}/{timeline.length}
          </span>
        )}
        <button
          type="button"
          onClick={onClear}
          className="px-2 h-6 rounded-sm text-text-muted hover:text-text hover:bg-surface-2 transition-colors shrink-0"
        >
          清空
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto">
        {isEmpty ? (
          <div className="flex items-center justify-center h-full text-text-muted">
            暂无编译信息
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-text-muted">
            无匹配日志
          </div>
        ) : (
          <ul className="px-2 py-1 space-y-0.5">
            {filtered.map((item, index) =>
              item.kind === 'event' ? (
                <li
                  key={`e-${item.at}-${index}`}
                  data-compile-row
                  data-status={item.event.status}
                  className="flex items-baseline gap-2 leading-5"
                >
                  <span className="text-text-muted tabular-nums shrink-0">
                    {formatTime(item.at)}
                  </span>
                  <span className={cn('break-all', statusClass(item.event.status))}>
                    {item.event.message}
                  </span>
                  {item.event.hotReload === true && (
                    <span className="shrink-0 px-1 rounded-sm bg-surface-2 text-text-muted">
                      热更新
                    </span>
                  )}
                  {item.durationMs !== null && (
                    <span
                      data-compile-duration
                      className="shrink-0 text-text-muted tabular-nums"
                    >
                      {(item.durationMs / 1000).toFixed(1)}s
                    </span>
                  )}
                </li>
              ) : (
                <li
                  key={`l-${item.at}-${index}`}
                  data-compile-log
                  data-stream={item.log.stream}
                  className="flex items-baseline gap-2 leading-5"
                >
                  <span className="text-text-muted tabular-nums shrink-0">
                    {formatTime(item.at)}
                  </span>
                  <span
                    className={cn(
                      'break-all font-mono',
                      item.log.stream === 'stderr' ? 'text-red-500' : 'text-text',
                    )}
                  >
                    {item.log.text}
                  </span>
                </li>
              ),
            )}
            <div ref={bottomRef} />
          </ul>
        )}
      </div>
    </div>
  )
}
