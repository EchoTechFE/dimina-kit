import type { RefObject } from 'react'

export type WebviewLike = HTMLElement & {
  getWebContentsId?: () => number
  getURL?: () => string
  reload?: () => void
  loadURL?: (url: string) => void
  send?: (channel: string, ...args: unknown[]) => void
}

export function asWebview(ref: RefObject<HTMLElement | null>): WebviewLike | null {
  return ref.current as WebviewLike | null
}
