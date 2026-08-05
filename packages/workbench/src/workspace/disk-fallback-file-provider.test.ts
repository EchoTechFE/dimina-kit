/**
 * Contract tests for `createDiskFallbackFileProvider`: the `file://` provider
 * wrapper that makes disk the single source of truth for workspace files.
 *
 * The editor reads every project file from an in-memory mirror (`file:///workspace`)
 * populated once per workbench boot. That mirror is a cache, and a cache can be
 * empty or partial at the exact moment a file is opened (the post-switch re-boot,
 * or the first-compile window) — VS Code's own open then throws FILE_NOT_FOUND and
 * leaves a stuck "The editor could not be opened because the file was not found."
 * placeholder.
 *
 * This wrapper delegates every read to the wrapped in-memory provider, but on a
 * read-miss for a `file:///workspace/*` URI it fetches the file from disk over the
 * `/__fs` bridge instead of throwing. A genuinely-missing file (bridge 404) still
 * reports not-found; non-workspace reads pass through untouched. These tests pin
 * that contract directly against a fake in-memory provider + a mocked `/__fs` bridge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IFileSystemProvider } from '@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files'
import { createDiskFallbackFileProvider } from './disk-fallback-file-provider.js'

/** A FILE_NOT_FOUND error shaped the way monaco-vscode-api's memfs throws it. */
function fileNotFound(uri: string): Error {
  return Object.assign(new Error(`FileNotFound: ${uri}`), {
    fileOperationResult: 1,
    code: 'FileNotFound',
  })
}

/** Minimal in-memory `file://` provider: throws FILE_NOT_FOUND for anything the
 * test flags, otherwise answers trivially. Exercises the wrapper's read-miss path. */
function makeBase(opts: {
  readFileThrows?: (uri: string) => Error | null
  statThrows?: (uri: string) => Error | null
  readdirThrows?: (uri: string) => Error | null
} = {}): IFileSystemProvider {
  return {
    capabilities: 2,
    onDidChangeCapabilities: vi.fn(),
    onDidChangeFile: vi.fn(),
    watch: vi.fn(),
    stat: vi.fn().mockImplementation((r: { toString(): string }) => {
      const e = opts.statThrows?.(r.toString())
      if (e) throw e
      return { type: 1, ctime: 0, mtime: 0, size: 0 }
    }),
    mkdir: vi.fn(),
    readdir: vi.fn().mockImplementation((r: { toString(): string }) => {
      const e = opts.readdirThrows?.(r.toString())
      if (e) throw e
      return []
    }),
    delete: vi.fn(),
    rename: vi.fn(),
    readFile: vi.fn().mockImplementation((r: { toString(): string }) => {
      const e = opts.readFileThrows?.(r.toString())
      if (e) throw e
      return new Uint8Array([1, 2, 3])
    }),
    writeFile: vi.fn(),
  } as unknown as IFileSystemProvider
}

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200 })
}
function bytesResponse(bytes: Uint8Array): Response {
  return new Response(bytes, { status: 200 })
}
function statusResponse(code: number): Response {
  return new Response('', { status: code })
}

const FS_BASE = 'https://workbench.local/'

describe('createDiskFallbackFileProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('falls back to disk when the in-memory mirror misses a workspace file', async () => {
    const base = makeBase({ readFileThrows: () => fileNotFound('file:///workspace/missing.js') })
    const provider = createDiskFallbackFileProvider(base, FS_BASE)

    const diskBytes = new Uint8Array([0x68, 0x69]) // "hi"
    fetchMock.mockResolvedValueOnce(bytesResponse(diskBytes))

    const got = await provider.readFile({ toString: () => 'file:///workspace/missing.js' })

    expect(got).toEqual(diskBytes)
    // The fallback reached the `/__fs/read` bridge for the right relative path.
    const calledUrl = String(fetchMock.mock.calls[0]?.[0])
    expect(calledUrl).toContain('__fs/read')
    expect(calledUrl).toContain('p=missing.js')
  })

  it('does not fall back for non-workspace URIs and lets the error propagate', async () => {
    const base = makeBase({ readFileThrows: () => fileNotFound('file:///other/x.js') })
    const provider = createDiskFallbackFileProvider(base, FS_BASE)

    await expect(
      provider.readFile({ toString: () => 'file:///other/x.js' }),
    ).rejects.toThrow(/FileNotFound/)
    // No bridge call: outside the workspace, the error is the memfs's to own.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('falls back to disk on a stat miss for a workspace directory/file', async () => {
    const base = makeBase({ statThrows: () => fileNotFound('file:///workspace/dir') })
    const provider = createDiskFallbackFileProvider(base, FS_BASE)

    fetchMock.mockResolvedValueOnce(jsonResponse({ type: 2, mtimeMs: 1700000000000 }))

    const st = await provider.stat({ toString: () => 'file:///workspace/dir' })

    expect(st.type).toBe(2)
    expect(st.size).toBe(0)
    const calledUrl = String(fetchMock.mock.calls[0]?.[0])
    expect(calledUrl).toContain('__fs/stat')
    expect(calledUrl).toContain('p=dir')
  })

  it('falls back to disk on a readdir miss for a workspace directory', async () => {
    const base = makeBase({ readdirThrows: () => fileNotFound('file:///workspace/dir') })
    const provider = createDiskFallbackFileProvider(base, FS_BASE)

    fetchMock.mockResolvedValueOnce(jsonResponse([['a.js', 1], ['sub', 2]]))

    const entries = await provider.readdir({ toString: () => 'file:///workspace/dir' })

    expect(entries).toEqual([['a.js', 1], ['sub', 2]])
    const calledUrl = String(fetchMock.mock.calls[0]?.[0])
    expect(calledUrl).toContain('__fs/readdir')
  })

  it('still reports not-found when the disk bridge itself returns 404 (file genuinely absent)', async () => {
    const base = makeBase({ readFileThrows: () => fileNotFound('file:///workspace/nope.js') })
    const provider = createDiskFallbackFileProvider(base, FS_BASE)

    fetchMock.mockResolvedValueOnce(statusResponse(404))

    await expect(
      provider.readFile({ toString: () => 'file:///workspace/nope.js' }),
    ).rejects.toThrow()
  })

  it('forwards write/mkdir/delete/rename straight to the wrapped provider', async () => {
    const base = makeBase()
    const provider = createDiskFallbackFileProvider(base, FS_BASE)
    const uri = { toString: () => 'file:///workspace/fresh.js' }

    await provider.writeFile(uri as never, new Uint8Array([9]), {} as never)
    await provider.mkdir(uri as never, {} as never)
    await provider.delete(uri as never, {} as never)
    await provider.rename(uri as never, uri as never, {} as never)

    expect(base.writeFile).toHaveBeenCalled()
    expect(base.mkdir).toHaveBeenCalled()
    expect(base.delete).toHaveBeenCalled()
    expect(base.rename).toHaveBeenCalled()
    // A write path never touches the read-only bridge.
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
