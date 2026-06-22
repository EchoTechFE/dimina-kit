import { useMemo } from 'react'
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
 * newest-first timeline. State stays isolated in useSession.
 */
export function CompilePanel({ events, logs = [], onClear }: CompilePanelProps) {
  const latest = events.length > 0 ? events[events.length - 1]! : null

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
    // Newest first by `at`. Within a same-`at` tie (millisecond stamps — an
    // event and the logs of the same compile collide routinely) the shared
    // monotonic `seq` keeps ARRIVAL order: without it, the events-then-logs
    // concat above plus the stable sort would rank events above logs no
    // matter which actually came first. Entries without `seq`
    // fall back to the stable insertion order.
    return items.sort((a, b) => {
      if (b.at !== a.at) return b.at - a.at
      if (a.seq !== undefined && b.seq !== undefined) return a.seq - b.seq
      return 0
    })
  }, [events, logs])

  const isEmpty = events.length === 0 && logs.length === 0

  return (
    <div className="flex flex-col h-full w-full min-h-0 text-[12px]">
      {/* Header: current-status badge (event-driven — log lines never hijack
          it) + the single 清空 action for both stores. */}
      <div className="flex items-center gap-2 px-2 h-8 shrink-0 border-b border-border-subtle">
        {latest ? (
          <span
            data-compile-current
            data-status={latest.status}
            className={cn('truncate font-medium', statusClass(latest.status))}
          >
            {latest.message}
          </span>
        ) : (
          <span className="text-text-muted">编译信息</span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClear}
          className="px-2 h-6 rounded-sm text-text-muted hover:text-text hover:bg-surface-2 transition-colors"
        >
          清空
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {isEmpty ? (
          <div className="flex items-center justify-center h-full text-text-muted">
            暂无编译信息
          </div>
        ) : (
          <ul className="px-2 py-1 space-y-0.5">
            {timeline.map((item, index) =>
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
          </ul>
        )}
      </div>
    </div>
  )
}
