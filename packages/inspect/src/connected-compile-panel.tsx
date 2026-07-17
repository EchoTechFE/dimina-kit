// The 编译 panel's data wiring, written once against CompilePanelSource: seed
// on the (enabled && active) rising edge, stay live by appending pushed
// events/logs under FIFO caps, stamp a shared monotonic `seq` onto unstamped
// arrivals (the merged timeline's same-`at` tie-break), forward the
// visibility gate, and route 清空. Hosts render this with their transport
// implementation and the pure CompilePanel view underneath never needs
// host-specific code.
import { useRef, useState } from 'react'
import { CompilePanel } from './compile-panel-view.js'
import { useSourceWiring } from './use-source-wiring.js'
import type { CompileFeedSnapshot, CompilePanelSource } from './compile-source.js'

export interface ConnectedCompilePanelProps {
  source: CompilePanelSource
  /** Panel visibility (the host's tab-active state). Defaults to true. */
  active?: boolean
  /** Data availability gate. While false the panel makes no source calls at
   * all and keeps the last rendered timeline. Defaults to true. */
  enabled?: boolean
}

/** events cap — FIFO, oldest evicted first. */
const MAX_COMPILE_EVENTS = 200
/** logs cap — FIFO, oldest evicted first. */
const MAX_COMPILE_LOGS = 300

const EMPTY_FEED: CompileFeedSnapshot = { events: [], logs: [] }

export function ConnectedCompilePanel({
  source,
  active = true,
  enabled = true,
}: ConnectedCompilePanelProps) {
  const [feed, setFeed] = useState<CompileFeedSnapshot>(EMPTY_FEED)
  // The shared arrival counter behind `seq` stamping. Ratcheted past every
  // explicit seq seen so a locally stamped item can never undercut one the
  // host stamped itself (which would silently reverse arrival order on a
  // same-`at` tie).
  const nextSeq = useRef(0)

  const stamp = <T extends { seq?: number }>(item: T): T => {
    if (item.seq !== undefined) {
      nextSeq.current = Math.max(nextSeq.current, item.seq + 1)
      return item
    }
    return { ...item, seq: nextSeq.current++ }
  }

  useSourceWiring({
    source,
    enabled,
    active,
    subscribe: s => s.subscribe((evt) => {
      if (evt.kind === 'reset') {
        setFeed(EMPTY_FEED)
        return
      }
      if (evt.kind === 'event') {
        const event = stamp(evt.event)
        setFeed(prev => ({
          ...prev,
          events: [...prev.events, event].slice(-MAX_COMPILE_EVENTS),
        }))
        return
      }
      const log = stamp(evt.log)
      setFeed(prev => ({
        ...prev,
        logs: [...prev.logs, log].slice(-MAX_COMPILE_LOGS),
      }))
    }),
    seed: (s, isDisposed) => {
      void s.getSnapshot().then((snap) => {
        if (isDisposed()) return
        setFeed({
          events: snap.events.map(stamp).slice(-MAX_COMPILE_EVENTS),
          logs: snap.logs.map(stamp).slice(-MAX_COMPILE_LOGS),
        })
      })
    },
  })

  const handleClear = () => {
    // The local timeline empties regardless; clearing the host-side history
    // is the optional capability.
    setFeed(EMPTY_FEED)
    void source.clear?.()
  }

  return <CompilePanel events={feed.events} logs={feed.logs} onClear={handleClear} />
}
