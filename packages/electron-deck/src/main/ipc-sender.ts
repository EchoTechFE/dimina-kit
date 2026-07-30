import type {
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents,
} from 'electron'

export type IpcSenderPolicy = (sender: WebContents) => boolean

type FrameRef = { routingId: number; processId: number } | null | undefined

/**
 * Accept only top-frame IPC. Frame-unaware unit-test stubs are allowed, while
 * real events with a missing or mismatched frame fail closed.
 */
export function isMainFrameIpcSender(
  event: IpcMainEvent | IpcMainInvokeEvent,
): boolean {
  const frame = (event as { senderFrame?: FrameRef }).senderFrame
  const main = (event.sender as { mainFrame?: FrameRef }).mainFrame
  if (frame === undefined && main === undefined) return true
  if (frame == null || main == null) return false
  return frame.routingId === main.routingId && frame.processId === main.processId
}
