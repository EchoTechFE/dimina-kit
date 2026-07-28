/**
 * Ring buffer over the per-line dmcc compile log, readable by cursor.
 *
 * The renderer gets each line pushed (`notify.compileLog`); MCP clients pull
 * incrementally instead: pass the previous read's `nextCursor` to receive
 * only lines that arrived since. `seq` is monotonic for the buffer's whole
 * lifetime — `clear()` (a fresh project open) drops the entries but never
 * resets the counter, so a stale cursor from before the clear simply reads
 * the new compile's lines instead of duplicating old ones.
 */

export interface CompileLogRecord {
  /** Monotonic id (1-based); never reused, survives clear(). */
  seq: number
  /** Main-process capture time of the line. */
  at: number
  stream: 'stdout' | 'stderr'
  text: string
}

export interface CompileLogRead {
  /** Oldest-first entries with seq > afterSeq (post stream-filter), capped at limit. */
  entries: CompileLogRecord[]
  /** Pass back as the next read's afterSeq; unchanged when nothing new matched. */
  nextCursor: number
}

export interface CompileLogBuffer {
  append(entry: { at: number; stream: 'stdout' | 'stderr'; text: string }): void
  read(opts?: {
    afterSeq?: number
    limit?: number
    stream?: 'stdout' | 'stderr'
  }): CompileLogRead
  /** Drop all entries (fresh compile timeline); seq keeps growing. */
  clear(): void
}

const DEFAULT_CAPACITY = 1000
const DEFAULT_READ_LIMIT = 100

export function createCompileLogBuffer(capacity = DEFAULT_CAPACITY): CompileLogBuffer {
  const entries: CompileLogRecord[] = []
  let seq = 0

  return {
    append(entry) {
      entries.push({ seq: ++seq, ...entry })
      if (entries.length > capacity) entries.splice(0, entries.length - capacity)
    },

    read({ afterSeq = 0, limit = DEFAULT_READ_LIMIT, stream } = {}) {
      const matched: CompileLogRecord[] = []
      for (const entry of entries) {
        if (entry.seq <= afterSeq) continue
        if (stream && entry.stream !== stream) continue
        matched.push(entry)
        if (matched.length >= limit) break
      }
      const last = matched[matched.length - 1]
      return { entries: matched, nextCursor: last ? last.seq : afterSeq }
    },

    clear() {
      entries.length = 0
    },
  }
}
