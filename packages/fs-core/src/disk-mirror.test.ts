/**
 * Contract tests for `createDiskMirror`'s lifecycle bookkeeping — the actual
 * disk I/O only runs in a real Chromium window, so these exercise the pure
 * scheduling/guard logic (pick(handle), dispose(), overlapping-sync pending
 * re-arm) against fake FileSystemDirectoryHandle/FileHandle doubles and a
 * fake `fs.snapshot()` source, using vitest's fake timers to control the 2s
 * debounce deterministically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDiskMirror } from './disk-mirror.js'

/** Minimal in-memory stand-in for a FileSystemFileHandle: buffers writes
 * until `close()`, matching the real API's write-then-close contract. */
class FakeFileHandle {
  content = ''
  private buf = ''
  async createWritable() {
    return {
      write: async (data: string) => {
        this.buf = data
      },
      close: async () => {
        this.content = this.buf
      },
    }
  }
}

/** Minimal in-memory stand-in for a FileSystemDirectoryHandle: supports the
 * three calls disk-mirror.js makes (getDirectoryHandle/getFileHandle/removeEntry)
 * over a nested tree, plus a `read(path)` test helper to inspect mirrored content. */
class FakeDirHandle {
  name: string
  private dirs = new Map<string, FakeDirHandle>()
  private fileHandles = new Map<string, FakeFileHandle>()
  constructor(name = '') {
    this.name = name
  }
  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDirHandle> {
    let d = this.dirs.get(name)
    if (!d) {
      if (!opts?.create) throw new Error(`not found: ${name}`)
      d = new FakeDirHandle(name)
      this.dirs.set(name, d)
    }
    return d
  }
  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileHandle> {
    let f = this.fileHandles.get(name)
    if (!f) {
      if (!opts?.create) throw new Error(`not found: ${name}`)
      f = new FakeFileHandle()
      this.fileHandles.set(name, f)
    }
    return f
  }
  async removeEntry(name: string): Promise<void> {
    if (this.fileHandles.delete(name)) return
    if (this.dirs.delete(name)) return
    throw new Error(`not found: ${name}`)
  }
  /** Test helper: reads mirrored content at a '/'-joined path, or undefined if absent. */
  read(path: string): string | undefined {
    const parts = path.split('/')
    let d: FakeDirHandle = this
    for (const seg of parts.slice(0, -1)) {
      const next = d.dirs.get(seg)
      if (!next) return undefined
      d = next
    }
    return d.fileHandles.get(parts[parts.length - 1] as string)?.content
  }
}

/** Fake `fs` source whose `snapshot()` call count and blocking can be
 * controlled from the test, to force a real overlap between an in-flight
 * `syncAll()` and a subsequent `schedule()`. */
function makeFs(initialFiles: Record<string, string>) {
  let files = { ...initialFiles }
  let gen = 0
  let calls = 0
  let blockOnCall = -1
  let releaseBlock: (() => void) | null = null
  const snapshot = vi.fn(async () => {
    calls++
    // Capture synchronously (before any `await`) so a mutation the test makes
    // *after* this call returns control is never smeared into this round's
    // snapshot — exactly mirroring how a real snapshot is a point-in-time read.
    const captured = { files: { ...files }, gen: ++gen }
    if (calls === blockOnCall) {
      await new Promise<void>((resolve) => {
        releaseBlock = resolve
      })
    }
    return captured
  })
  return {
    fs: { snapshot },
    setFiles(next: Record<string, string>) {
      files = { ...next }
    },
    callCount: () => calls,
    /** Makes the Nth `snapshot()` call block (after capturing) until `release()` is called. */
    blockCall(n: number) {
      blockOnCall = n
    },
    release() {
      const r = releaseBlock
      releaseBlock = null
      r?.()
    },
  }
}

describe('createDiskMirror', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('pick(handle) uses the injected handle directly, skipping showDirectoryPicker', async () => {
    const { fs } = makeFs({ 'a.txt': '1' })
    const mirror = createDiskMirror(fs)
    const dir = new FakeDirHandle('root')

    const r = await mirror.pick(dir as unknown as FileSystemDirectoryHandle)

    expect(r.name).toBe('root')
    expect(dir.read('a.txt')).toBe('1')
    expect(mirror.active).toBe(true)
  })

  it('dispose() cancels the pending debounce timer and short-circuits later syncAll calls', async () => {
    const { fs, callCount } = makeFs({ 'a.txt': '1' })
    const mirror = createDiskMirror(fs)
    const dir = new FakeDirHandle('root')
    await mirror.pick(dir as unknown as FileSystemDirectoryHandle)
    const callsAfterPick = callCount()

    mirror.schedule() // arms the 2s debounce timer
    mirror.dispose()
    expect(mirror.active).toBe(false)

    await vi.advanceTimersByTimeAsync(5000)
    // The cleared timer never fires syncAll again.
    expect(callCount()).toBe(callsAfterPick)

    // Defense in depth: even a direct syncAll() call after dispose is a no-op.
    const r = await mirror.syncAll()
    expect(r).toBeNull()
    expect(callCount()).toBe(callsAfterPick)
  })

  it('re-arms and mirrors a change that happened while a sync was already in flight', async () => {
    const { fs, setFiles, callCount, blockCall, release } = makeFs({ 'a.txt': '1' })
    const mirror = createDiskMirror(fs)
    const dir = new FakeDirHandle('root')

    await mirror.pick(dir as unknown as FileSystemDirectoryHandle) // snapshot call #1
    expect(dir.read('a.txt')).toBe('1')

    // Round 2: block after the snapshot for call #2 is captured, simulating a
    // sync still "in flight" (syncing === true) while further changes land.
    blockCall(2)
    mirror.schedule()
    await vi.advanceTimersByTimeAsync(2000) // fires the timer -> syncAll() call #2 starts and blocks

    // While round 2 is in flight, a new change arrives and schedule() is called
    // again. Assert schedule() does NOT arm a fresh timer while syncing is
    // true (it must set `pending` instead): advancing time here, while call #2
    // is still blocked/in-flight, must NOT produce any further snapshot() call.
    // The old implementation unconditionally re-armed a timer here, which
    // would fire into `syncAll()`'s own `syncing` guard and silently drop the
    // update forever (no retry is ever scheduled after a guard-drop).
    setFiles({ 'a.txt': '2' })
    mirror.schedule()
    await vi.advanceTimersByTimeAsync(2000)
    expect(callCount()).toBe(2) // still just call #2, blocked — no drop, no premature retry

    release() // let call #2 finish; it writes the *old* ('1') snapshot it had captured
    await vi.waitFor(() => expect(dir.read('a.txt')).toBe('1'))

    // The finally-block pending re-arm should have scheduled a fresh 2s timer
    // only once call #2 actually finished.
    await vi.advanceTimersByTimeAsync(2000) // fires -> syncAll() call #3, captures the new value

    expect(dir.read('a.txt')).toBe('2')
    expect(callCount()).toBe(3)
  })
})
