import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { RefObject } from 'react'
import {
  MiniappSnapshotChannel,
} from '../../../../../../shared/ipc-channels'
import type {
  SnapshotEnvelope,
  SnapshotSourceId,
} from '../../../../../../preload/miniapp-snapshot/types'
import { ATTACH_RETRY_INTERVAL_MS, MAX_ATTACH_RETRIES } from '../../../../../../preload/shared/constants'
import { asWebview } from './webview-helpers'

export interface UseMiniappSnapshotParams<T> {
  /** Identifier of the snapshot source to project, e.g. 'appdata' | 'wxml'. */
  id: SnapshotSourceId
  /** Initial state used before the first envelope arrives. */
  initial: T
  /** Ref to the simulator `<webview>` element. */
  simulatorRef: RefObject<HTMLElement | null>
  /** When false, no listener is attached and `data` stays `initial`. */
  enabled: boolean
}

export interface UseMiniappSnapshotResult<T> {
  /** The latest full snapshot — a pure projection, never merged. */
  data: T
  /** The global seq of the latest applied envelope (0 before any). */
  seq: number
  /** Request a fresh push of this source from preload. */
  refresh: () => void
}

/**
 * Projects a preload-side `MiniappSnapshotSource` into React state.
 *
 * Listens for `MiniappSnapshotChannel.Push` envelopes on the simulator
 * `<webview>`, drops envelopes for other sources and stale/out-of-order ones
 * (by global `seq`), and replaces `data` wholesale with each accepted
 * snapshot. `refresh()` sends a `Pull` so preload re-publishes this source.
 */
export function useMiniappSnapshot<T>(
  params: UseMiniappSnapshotParams<T>,
): UseMiniappSnapshotResult<T> {
  const { id, initial, simulatorRef, enabled } = params

  const [data, setData] = useState<T>(initial)
  const [seq, setSeq] = useState(0)
  // Last seq applied — read synchronously inside the listener so two
  // envelopes in the same tick still get the stale-guard.
  const lastSeqRef = useRef(0)

  useEffect(() => {
    if (!enabled) return

    const onIpcMessage = (event: Event) => {
      const { channel, args } = event as Event & { channel: string; args: unknown[] }
      if (channel !== MiniappSnapshotChannel.Push) return
      const envelope = args[0] as SnapshotEnvelope<T> | undefined
      if (!envelope || envelope.id !== id) return
      // Drop stale / out-of-order envelopes — global seq is strictly
      // increasing, so anything not newer than the last applied is obsolete.
      if (envelope.seq <= lastSeqRef.current) return
      lastSeqRef.current = envelope.seq
      setData(envelope.data)
      setSeq(envelope.seq)
    }

    // The <webview> element mounts asynchronously; bind once it appears via a
    // bounded retry loop (same pattern/constants as use-panel-data's
    // tryAttach and preload's tryAttach).
    let attached: HTMLElement | null = null
    let pollTimer: number | null = null
    let attempts = 0

    const tryAttach = () => {
      if (attached) return
      const webview = asWebview(simulatorRef)
      if (!webview) {
        attempts += 1
        if (attempts >= MAX_ATTACH_RETRIES && pollTimer !== null) {
          window.clearInterval(pollTimer)
          pollTimer = null
        }
        return
      }
      attached = webview
      if (pollTimer !== null) {
        window.clearInterval(pollTimer)
        pollTimer = null
      }
      webview.addEventListener('ipc-message', onIpcMessage)
    }

    tryAttach()
    if (!attached) {
      pollTimer = window.setInterval(tryAttach, ATTACH_RETRY_INTERVAL_MS)
    }

    return () => {
      if (pollTimer !== null) {
        window.clearInterval(pollTimer)
        pollTimer = null
      }
      if (attached) {
        attached.removeEventListener('ipc-message', onIpcMessage)
      }
    }
  }, [enabled, id, simulatorRef])

  const refresh = useCallback(() => {
    asWebview(simulatorRef)?.send?.(MiniappSnapshotChannel.Pull, { id })
  }, [id, simulatorRef])

  return { data, seq, refresh }
}
