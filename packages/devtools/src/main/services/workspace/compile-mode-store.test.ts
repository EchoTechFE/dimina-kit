/**
 * `openCompileModeStore` is the single owner of one open project's compile
 * modes: it is the only thing allowed to read/write the persisted file and
 * to advance the in-memory snapshot. The invariant under test throughout is
 * persist-before-adopt — a write that fails on disk must never be visible in
 * `get()` or broadcast to `onChange` listeners — plus commands are
 * serialized so two `apply()` calls issued back-to-back never interleave
 * their persists.
 *
 * Design: /Volumes/jdisk/code/dimina-kit-docs/compile-mode-store-design.md §2.3
 */
import { describe, it, expect, vi } from 'vitest'
import { openCompileModeStore } from './compile-mode-store.js'
import type { CompileModes } from '../../../shared/types.js'

const emptyStored: CompileModes = { current: -1, list: [] }
const oneModeStored: CompileModes = {
  current: 0,
  list: [{ name: 'A', pathName: 'pages/a/a', query: '', scene: null }],
}
const addB = {
  type: 'add' as const,
  mode: { name: 'B', pathName: 'pages/b/b', query: '', scene: null },
}

function makeInput(initialStored: CompileModes = emptyStored) {
  return {
    projectPath: '/tmp/compile-mode-store-project',
    load: vi.fn(async () => initialStored),
    persist: vi.fn(async (_stored: CompileModes) => {}),
  }
}

describe('openCompileModeStore: initial get()', () => {
  it('reflects the loaded file after opening', async () => {
    const store = await openCompileModeStore(makeInput(oneModeStored))
    expect(store.get().state.selectedId).not.toBeNull()
    store.dispose()
  })

  it('starts at revision 0 for a freshly opened store', async () => {
    const store = await openCompileModeStore(makeInput())
    expect(store.get().revision).toBe(0)
    store.dispose()
  })
})

describe('openCompileModeStore: apply() — persist before adopt/broadcast', () => {
  it('persists to disk, then advances get()/revision, then notifies listeners — in that order', async () => {
    const input = makeInput()
    const order: string[] = []
    input.persist.mockImplementation(async () => {
      order.push('persist')
    })
    const store = await openCompileModeStore(input)
    store.onChange(() => order.push('listener'))

    await store.apply(addB)
    order.push('after-apply-return')

    expect(order).toEqual(['persist', 'listener', 'after-apply-return'])
    store.dispose()
  })

  it('advances the revision by exactly one per successful apply', async () => {
    const store = await openCompileModeStore(makeInput())
    const before = store.get().revision
    await store.apply(addB)
    expect(store.get().revision).toBe(before + 1)
    store.dispose()
  })

  it('resolves with the applied change (new state + relaunch flag)', async () => {
    const store = await openCompileModeStore(makeInput())
    const change = await store.apply(addB)
    expect(change.relaunch).toBe(true)
    expect(change.state.entries).toHaveLength(1)
    expect(change.revision).toBe(1)
    store.dispose()
  })

  it('passes storedFromState(next) — not the raw command — to persist', async () => {
    const input = makeInput()
    const store = await openCompileModeStore(input)
    await store.apply(addB)
    expect(input.persist).toHaveBeenCalledWith({
      current: 0,
      list: [{ name: 'B', pathName: 'pages/b/b', query: '', scene: null }],
    })
    store.dispose()
  })
})

describe('openCompileModeStore: apply() — persist failure must not be adopted', () => {
  it('rejects, leaves get() unchanged, and does not notify listeners when persist rejects', async () => {
    const input = makeInput()
    const store = await openCompileModeStore(input)
    const before = store.get()
    const listener = vi.fn()
    store.onChange(listener)
    input.persist.mockRejectedValueOnce(new Error('磁盘写入失败'))

    await expect(store.apply(addB)).rejects.toThrow('磁盘写入失败')

    expect(store.get()).toEqual(before)
    expect(listener).not.toHaveBeenCalled()
    store.dispose()
  })
})

describe('openCompileModeStore: apply() — no-op commands', () => {
  it('does not touch disk, does not advance the revision, and does not notify for a no-op command', async () => {
    const input = makeInput(oneModeStored)
    const store = await openCompileModeStore(input)
    input.persist.mockClear()
    const listener = vi.fn()
    store.onChange(listener)
    const before = store.get()

    const change = await store.apply({ type: 'select', id: 'this-id-does-not-exist' })

    expect(input.persist).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
    expect(store.get()).toEqual(before)
    expect(change.relaunch).toBe(false)
    expect(change.revision).toBe(before.revision)
    store.dispose()
  })
})

describe('openCompileModeStore: apply() — serialized concurrent calls', () => {
  it("runs a second apply()'s persist only after the first one's persist has settled", async () => {
    const order: string[] = []
    const persistGates: Array<() => void> = []
    const input = makeInput()
    input.persist.mockImplementation(async () => {
      order.push('persist-start')
      await new Promise<void>((resolve) => persistGates.push(resolve))
      order.push('persist-end')
    })
    const store = await openCompileModeStore(input)

    const firstApply = store.apply(addB).then(() => order.push('first-apply-resolved'))
    const secondApply = store
      .apply({ type: 'add', mode: { name: 'C', pathName: 'pages/c/c', query: '', scene: null } })
      .then(() => order.push('second-apply-resolved'))

    // Let both apply() calls run up to their first await; only the first
    // command's persist may have started. `vi.waitFor` instead of counting
    // microtasks so the assertion does not depend on how many awaits the
    // queue takes before reaching persist.
    await vi.waitFor(() => expect(order).toEqual(['persist-start']))

    persistGates[0]?.()
    await firstApply
    await vi.waitFor(() =>
      expect(order).toEqual(['persist-start', 'persist-end', 'first-apply-resolved', 'persist-start']),
    )

    persistGates[1]?.()
    await secondApply
    expect(order.at(-1)).toBe('second-apply-resolved')
    store.dispose()
  })

  it("the second apply's persist sees the first apply's entry already in the list", async () => {
    const persistedCalls: CompileModes[] = []
    const persistGates: Array<() => void> = []
    const input = makeInput()
    input.persist.mockImplementation(async (stored: CompileModes) => {
      await new Promise<void>((resolve) => persistGates.push(resolve))
      persistedCalls.push(stored)
    })
    const store = await openCompileModeStore(input)

    const firstApply = store.apply(addB)
    const secondApply = store.apply({
      type: 'add',
      mode: { name: 'C', pathName: 'pages/c/c', query: '', scene: null },
    })

    await vi.waitFor(() => expect(persistGates).toHaveLength(1))
    persistGates[0]?.()
    await firstApply
    await vi.waitFor(() => expect(persistGates).toHaveLength(2))
    persistGates[1]?.()
    await secondApply

    expect(persistedCalls[0]?.list).toHaveLength(1)
    expect(persistedCalls[1]?.list.map((m) => m.pathName)).toEqual(['pages/b/b', 'pages/c/c'])
    store.dispose()
  })
})

describe('openCompileModeStore: dispose()', () => {
  it('rejects a subsequent apply() and stops delivering onChange notifications', async () => {
    const store = await openCompileModeStore(makeInput())
    const listener = vi.fn()
    store.onChange(listener)
    store.dispose()

    await expect(store.apply(addB)).rejects.toThrow()
    expect(listener).not.toHaveBeenCalled()
  })

  it('is idempotent — calling dispose() twice does not throw', async () => {
    const store = await openCompileModeStore(makeInput())
    store.dispose()
    expect(() => store.dispose()).not.toThrow()
  })

  it('lets an unsubscribe returned from onChange stop that one listener without disposing the store', async () => {
    const store = await openCompileModeStore(makeInput())
    const listener = vi.fn()
    const unsubscribe = store.onChange(listener)
    unsubscribe()

    await store.apply(addB)
    expect(listener).not.toHaveBeenCalled()
    store.dispose()
  })
})

describe('openCompileModeStore: load() rejection', () => {
  it('propagates a load() failure instead of opening with a silently-empty state', async () => {
    const input = makeInput()
    input.load.mockRejectedValueOnce(new Error('读取配置失败'))
    await expect(openCompileModeStore(input)).rejects.toThrow('读取配置失败')
  })
})
