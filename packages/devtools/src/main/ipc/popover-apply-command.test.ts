/**
 * The popover no longer computes a whole new compile-mode list and ships it
 * back — it sends a single command, and main is the one that owns applying
 * it. Two invariants this exercises:
 *  - Apply always hides the popover BEFORE touching the store, so a slow or
 *    failing apply can never leave a stale popover window on screen.
 *  - Show never trusts whatever `modes`/`state` a stale renderer might still
 *    send — it always injects the live state from the currently open
 *    project's store.
 *
 * Harness pattern lifted from session-rebuild.test.ts: capture registered
 * ipcMain.handle callbacks into a Map instead of exercising real IPC. The
 * captured callback is the registry's `(event, ...args)` wrapper — it resolves
 * `ctx` from the plain context object handed to `registerPopoverIpc`, so tests
 * call it as `handler({}, payload)`, never with `ctx` as the first argument.
 *
 * Design: /Volumes/jdisk/code/dimina-kit-docs/compile-mode-store-design.md §2.5
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PopoverChannel } from '../../shared/ipc-channels-overlays.js'

const stub = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => unknown
  const handled = new Map<string, Handler>()
  return {
    handled,
    ipcMain: {
      handle: vi.fn((channel: string, fn: Handler) => {
        handled.set(channel, fn)
      }),
      removeHandler: vi.fn((channel: string) => {
        handled.delete(channel)
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
      removeAllListeners: vi.fn(),
    },
  }
})

vi.mock('electron', () => ({ ipcMain: stub.ipcMain, default: { ipcMain: stub.ipcMain } }))

beforeEach(() => {
  stub.handled.clear()
  stub.ipcMain.handle.mockClear()
})

interface FakeCompileModeState {
  selectedId: string | null
  entries: Array<{ id: string; mode: { name: string; pathName: string; query: string; scene: number | null } }>
}

const emptyState: FakeCompileModeState = { selectedId: null, entries: [] }

function makeCtx() {
  return {
    views: { showPopover: vi.fn(), hidePopover: vi.fn() },
    notify: { compileModesApplyFailed: vi.fn() },
    workspace: {
      getCompileModeState: vi.fn((): { revision: number; state: FakeCompileModeState } => ({
        revision: 3,
        state: emptyState,
      })),
      applyCompileModeCommand: vi.fn(async () => ({ revision: 4, state: emptyState, relaunch: false })),
    },
    senderPolicy: undefined,
  }
}
type FakeCtx = ReturnType<typeof makeCtx>

async function setupPopoverIpc(ctx: FakeCtx) {
  const { registerPopoverIpc } = await import('./popover.js')
  const disposable = registerPopoverIpc(ctx as never)
  return { disposable }
}

function getHandler(channel: string) {
  const handler = stub.handled.get(channel)
  expect(handler, `registerPopoverIpc must register a handler for ${channel}`).toBeDefined()
  return handler!
}

describe('popover Apply handler: ordering', () => {
  it('hides the popover before invoking applyCompileModeCommand', async () => {
    const ctx = makeCtx()
    const order: string[] = []
    ctx.views.hidePopover.mockImplementation(() => order.push('hide'))
    ctx.workspace.applyCompileModeCommand.mockImplementation(async () => {
      order.push('apply')
      return { revision: 4, state: emptyState, relaunch: false }
    })
    const { disposable } = await setupPopoverIpc(ctx)

    const handler = getHandler(PopoverChannel.Apply)
    await handler({},{ command: { type: 'select', id: null } })

    expect(order).toEqual(['hide', 'apply'])
    await disposable.dispose()
  })
})

describe('popover Apply handler: success/failure notify behavior', () => {
  it('does not notify compileModesApplyFailed on success', async () => {
    const ctx = makeCtx()
    const { disposable } = await setupPopoverIpc(ctx)
    const handler = getHandler(PopoverChannel.Apply)

    await handler({},{ command: { type: 'select', id: null } })

    expect(ctx.notify.compileModesApplyFailed).not.toHaveBeenCalled()
    await disposable.dispose()
  })

  it('notifies compileModesApplyFailed with the error message when the store rejects the command', async () => {
    const ctx = makeCtx()
    ctx.workspace.applyCompileModeCommand.mockRejectedValueOnce(new Error('磁盘写入失败'))
    const { disposable } = await setupPopoverIpc(ctx)
    const handler = getHandler(PopoverChannel.Apply)

    // The popover has already been hidden by this point — whatever the
    // handler does with its own return value, the renderer-facing signal is
    // the notify call, not the invoke's resolution.
    await Promise.resolve(handler({}, { command: { type: 'select', id: null } })).catch(() => {})

    expect(ctx.notify.compileModesApplyFailed).toHaveBeenCalledWith({ message: '磁盘写入失败' })
    await disposable.dispose()
  })
})

describe('popover Show handler: injects live state, ignores renderer-supplied modes', () => {
  it('forwards ctx.workspace.getCompileModeState(...).state to the popover window', async () => {
    const ctx = makeCtx()
    const liveState = { selectedId: 'm1', entries: [{ id: 'm1', mode: { name: 'A', pathName: 'pages/a/a', query: '', scene: null } }] }
    ctx.workspace.getCompileModeState.mockReturnValue({ revision: 7, state: liveState })
    const { disposable } = await setupPopoverIpc(ctx)
    const handler = getHandler(PopoverChannel.Show)

    await handler({},{
      top: 0,
      left: 0,
      pages: ['pages/a/a'],
      entryPagePath: 'pages/a/a',
      currentRoute: 'pages/a/a',
      // A stale/misbehaving renderer still sending the old field — must be ignored.
      modes: { current: -1, list: [{ name: 'stale', pathName: 'pages/z/z', query: '', scene: null }] },
    })

    expect(ctx.workspace.getCompileModeState).toHaveBeenCalled()
    const [forwarded] = ctx.views.showPopover.mock.calls.at(-1) ?? []
    expect(forwarded.state).toEqual(liveState)
    expect(forwarded.modes).toBeUndefined()
    await disposable.dispose()
  })
})

describe('popover Apply handler: schema rejection', () => {
  it('rejects an unknown command type without calling applyCompileModeCommand', async () => {
    const ctx = makeCtx()
    const { disposable } = await setupPopoverIpc(ctx)
    const handler = getHandler(PopoverChannel.Apply)

    await expect(handler({}, { command: { type: 'not-a-real-command' } })).rejects.toThrow()
    expect(ctx.workspace.applyCompileModeCommand).not.toHaveBeenCalled()
    await disposable.dispose()
  })

  it('rejects a select command with a non-string, non-null id without calling applyCompileModeCommand', async () => {
    const ctx = makeCtx()
    const { disposable } = await setupPopoverIpc(ctx)
    const handler = getHandler(PopoverChannel.Apply)

    await expect(handler({}, { command: { type: 'select', id: 42 } })).rejects.toThrow()
    expect(ctx.workspace.applyCompileModeCommand).not.toHaveBeenCalled()
    await disposable.dispose()
  })

  it('rejects a remove command with an empty-string id without calling applyCompileModeCommand', async () => {
    const ctx = makeCtx()
    const { disposable } = await setupPopoverIpc(ctx)
    const handler = getHandler(PopoverChannel.Apply)

    await expect(handler({}, { command: { type: 'remove', id: '' } })).rejects.toThrow()
    expect(ctx.workspace.applyCompileModeCommand).not.toHaveBeenCalled()
    await disposable.dispose()
  })
})
