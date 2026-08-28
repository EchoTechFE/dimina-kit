/**
 * `OverlayChannel.Ready` must be handled by exactly ONE main-process
 * listener, no matter how many overlay-owning ipc modules are wired into
 * the same workbench — `markOverlayReady` is otherwise invoked once per
 * registration for a single renderer event (same-state-two-owners; still
 * idempotent today, but redundant work that would double if a future
 * consumer made it non-idempotent).
 */
import { EventEmitter } from 'events'
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: new EventEmitter(),
}))

import { ipcMain } from 'electron'
import { OverlayChannel } from '../../shared/ipc-channels-overlays.js'
import { registerTooltipIpc } from './tooltip.js'
import { registerProjectCreateIpc } from './project-create.js'

describe('OverlayChannel.Ready: single registration across overlay-owning ipc modules', () => {
  it('fires markOverlayReady exactly once when tooltip + project-create are both wired', () => {
    const markOverlayReady = vi.fn()

    registerTooltipIpc({
      views: {
        prepareTooltip: vi.fn(),
        showTooltip: vi.fn(),
        hideTooltip: vi.fn(),
        markOverlayReady,
        applyTooltipMeasurement: vi.fn(),
      },
    })
    registerProjectCreateIpc({
      views: {
        showProjectCreateDialog: vi.fn(),
        hideProjectCreateDialog: vi.fn(),
      },
      notify: { projectCreateSubmitted: vi.fn() },
    })

    ;(ipcMain as unknown as EventEmitter).emit(OverlayChannel.Ready, { sender: { id: 7 } })

    expect(markOverlayReady).toHaveBeenCalledTimes(1)
    expect(markOverlayReady).toHaveBeenCalledWith(7)
  })
})
