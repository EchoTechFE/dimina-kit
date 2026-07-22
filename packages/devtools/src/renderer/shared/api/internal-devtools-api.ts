import { InternalDevtoolsChannel } from '../../../shared/ipc-channels'
import { invoke } from './ipc-transport'

/**
 * Open (or focus) the standalone internal DevTools — the app-wide debug
 * surface, separate from the right-panel CDP that inspects the user's
 * mini-program. Drives the main-process 'internal-devtools:open' handler.
 */
export function openInternalDevtools(): Promise<void> {
  return invoke<void>(InternalDevtoolsChannel.Open)
}
