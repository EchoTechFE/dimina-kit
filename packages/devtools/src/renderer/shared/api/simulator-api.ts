import type { CompileConfig, LaunchConfig } from '@/shared/types'
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

/** Switch to a named launch config (by id) or revert to normal mode (null). */
export function emitPopoverSwitchLaunchConfig(id: string | null): void {
  send(PopoverChannel.SwitchLaunchConfig, id)
}

/** Persist an updated launch configs list from the popover editor. */
export function emitPopoverUpdateLaunchConfigs(configs: LaunchConfig[]): void {
  send(PopoverChannel.UpdateLaunchConfigs, configs)
}
