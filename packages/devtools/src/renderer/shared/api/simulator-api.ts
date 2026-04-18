import type { CompileConfig } from '@/shared/types'
import { PopoverChannel } from '../../../shared/ipc-channels'
import { send } from './ipc-transport'

/**
 * Simulator-facing IPC facade. The popover window, once the user clicks
 * "Relaunch", dispatches the updated compile config back to the main process
 * which then forwards it to the project-runtime window as `popover:relaunch`.
 */
export function emitPopoverRelaunch(config: CompileConfig): void {
  send(PopoverChannel.Relaunch, config)
}
