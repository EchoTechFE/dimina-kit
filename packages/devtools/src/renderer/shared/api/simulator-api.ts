import type { CompileModeCommand } from '@/shared/types'
import { PopoverChannel } from '../../../shared/ipc-channels-overlays'
import { invokeStrict } from './ipc-transport'

/**
 * Simulator-facing IPC facade. The popover window sends the command the user
 * just issued (select/add/update/remove) back to the main process, which
 * interprets it against the authoritative `CompileModeStore` and hides the
 * popover. `relaunch`, whether the running configuration changed, is decided
 * by main — the popover only names the edit, not its effect.
 */
export function applyPopoverCommand(command: CompileModeCommand): Promise<void> {
  return invokeStrict<void>(PopoverChannel.Apply, { command })
}
