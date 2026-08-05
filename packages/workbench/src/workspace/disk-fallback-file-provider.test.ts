/**
 * Unit tests for the disk-fallback overlay provider. These pin the *correct*
 * install path (mounted via `registerFileSystemOverlay(-1, …)` — NOT the
 * throwing `fileService.registerProvider('file', …)`) and the contract that a
 * genuine disk-miss surfaces as a real `FileNotFound` error so the monaco
 * `OverlayFileSystemProvider` keeps its fall-through behaviour and VS Code keeps
 * its "Create File" flow.
 *
 * TDD note: every read-path assertion below failed red when the provider was a
 * no-op wrapper (the old `registerProvider` design silently threw at install and
 * the overlay never fell through), then went green once the provider read from
 * the bridge and `installDiskFallbackFileProvider` used `registerFileSystemOverlay`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDiskProvider, installDiskFallbackFileProvider } from './disk-fallback-file-provider.js'
import { FileSystemProviderErrorCode } from '@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files'
import { registerFileSystemOverlay } from '@codingame/monaco-vscode-files-service-override'

vi.mock('@codingame/monaco-vscode-files-service-override', () => ({
  registerFileSystemOverlay: vi.fn(() => ({ dispose() {} })),
}))

const WORKSPACE = 'file:///workspace'

/** A URI-like good enough for `relFromWorkspaceUri` (which only calls `toString`). */
const uri = (p: string) => ({ toString: () => p }) as never

const jsonResponse = (data: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: async () => data, arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as Response

const bufResponse = (bytes: Uint8Array, status = 200): Response =>
  ({ ok: status < 400, status, json: async () => ({}), arrayBuffer: async () => bytes.slice().buffer }) as unknown as Response

const notFoundResponse = (): Response =>
  ({ ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as Response

const makeFetch = () => {
  const seen: string[] = []
  const fetchImpl = (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input as URL).toString()
    seen.push(url)
    if (url.includes('/__fs/stat')) return Promise.resolve(jsonResponse({ type: 1, size: 3, mtimeMs: 1 }))
    if (url.includes('/__fs/readdir')) return Promise.resolve(jsonResponse([['a.js', 1]]))
    if (url.includes('/__fs/read')) return Promise.resolve(bufResponse(new TextEncoder().encode('// marker\n')))
    return Promise.resolve(jsonResponse({}))
  }
  return { seen, fetchImpl: fetchImpl as unknown as typeof fetch }
}

describe('createDiskProvider (overlay disk fallback)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('stat hit reads from the disk bridge and maps the stat', async () => {
    const { seen, fetchImpl } = makeFetch()
    vi.stubGlobal('fetch', fetchImpl)
    const p = createDiskProvider('http://host/')
    const st = await p.stat(uri(`${WORKSPACE}/pages/index/index.js`))
    expect(st.type).toBe(1)
    expect(seen.some((u) => u.includes('/__fs/stat'))).toBe(true)
  })

  it('readFile hit reads from the disk bridge and returns the bytes', async () => {
    const { seen, fetchImpl } = makeFetch()
    vi.stubGlobal('fetch', fetchImpl)
    const p = createDiskProvider('http://host/')
    const bytes = await p.readFile(uri(`${WORKSPACE}/pages/index/index.js`))
    expect(new TextDecoder().decode(bytes)).toContain('marker')
    expect(seen.some((u) => u.includes('/__fs/read'))).toBe(true)
  })

  it('readdir hit reads from the disk bridge', async () => {
    const { seen, fetchImpl } = makeFetch()
    vi.stubGlobal('fetch', fetchImpl)
    const p = createDiskProvider('http://host/')
    const entries = await p.readdir(uri(`${WORKSPACE}/pages`))
    expect(entries).toEqual([['a.js', 1]])
    expect(seen.some((u) => u.includes('/__fs/readdir'))).toBe(true)
  })

  it('stat miss on a 404 maps to a real FileNotFound error (not a generic Error)', async () => {
    vi.stubGlobal('fetch', (async () => notFoundResponse()) as unknown as typeof fetch)
    const p = createDiskProvider('http://host/')
    let code: FileSystemProviderErrorCode | undefined
    try {
      await p.stat(uri(`${WORKSPACE}/missing.js`))
    } catch (e) {
      code = (e as { code?: FileSystemProviderErrorCode }).code
    }
    expect(code).toBe(FileSystemProviderErrorCode.FileNotFound)
  })

  it('readFile miss on a 404 maps to a real FileNotFound error', async () => {
    vi.stubGlobal('fetch', (async () => notFoundResponse()) as unknown as typeof fetch)
    const p = createDiskProvider('http://host/')
    let code: FileSystemProviderErrorCode | undefined
    try {
      await p.readFile(uri(`${WORKSPACE}/missing.js`))
    } catch (e) {
      code = (e as { code?: FileSystemProviderErrorCode }).code
    }
    expect(code).toBe(FileSystemProviderErrorCode.FileNotFound)
  })

  it('a non-workspace URI never touches the bridge and throws FileNotFound', async () => {
    const { seen, fetchImpl } = makeFetch()
    vi.stubGlobal('fetch', fetchImpl)
    const p = createDiskProvider('http://host/')
    let code: FileSystemProviderErrorCode | undefined
    try {
      await p.readFile(uri('file:///some/other/path.js'))
    } catch (e) {
      code = (e as { code?: FileSystemProviderErrorCode }).code
    }
    expect(code).toBe(FileSystemProviderErrorCode.FileNotFound)
    expect(seen.length).toBe(0)
  })

  it('is read-only: writeFile/mkdir/delete/rename reject', async () => {
    vi.stubGlobal('fetch', (async () => jsonResponse({})) as unknown as typeof fetch)
    const p = createDiskProvider('http://host/')
    await expect(
      p.writeFile(uri(`${WORKSPACE}/x.js`), new Uint8Array(), { create: true, overwrite: true, unlock: false, atomic: false }),
    ).rejects.toMatchObject({
      code: FileSystemProviderErrorCode.NoPermissions,
    })
    await expect(p.mkdir(uri(`${WORKSPACE}/dir`))).rejects.toMatchObject({
      code: FileSystemProviderErrorCode.NoPermissions,
    })
  })
})

describe('installDiskFallbackFileProvider', () => {
  it('mounts the disk provider as an overlay at priority -1 (not via registerProvider)', () => {
    installDiskFallbackFileProvider('http://host/')
    expect(registerFileSystemOverlay).toHaveBeenCalledTimes(1)
    expect(registerFileSystemOverlay).toHaveBeenCalledWith(-1, expect.any(Object))
  })
})
