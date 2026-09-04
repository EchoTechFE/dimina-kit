import type { CompileModes } from '@/shared/types'
import { PopoverChannel } from '../../../shared/ipc-channels-overlays'
import { send } from './ipc-transport'

/**
 * Simulator-facing IPC facade. The popover window sends the compile modes the
 * user just edited back to the main process, which closes the popover and
 * forwards them to the project-runtime window as `popover:apply`.
 *
 * `relaunch` is the popover's call: selecting a mode, or editing the selected
 * one, changes what should be running; editing some other mode does not.
 */
export function emitPopoverApply(payload: {
  modes: CompileModes
  relaunch: boolean
}): void {
  send(PopoverChannel.Apply, payload)
}
