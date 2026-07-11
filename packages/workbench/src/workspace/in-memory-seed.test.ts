/**
 * Guards the in-memory workspace source's populate contract: every seed file
 * is written into the workspace memfs under the folder URI (default
 * `file:///workspace`, overridable), and the count of written files is
 * returned. No save-back surface exists — saves stay in memfs.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IFileService } from '@codingame/monaco-vscode-api'
import { inMemorySeedSource } from './in-memory-seed.js'

function makeFileService() {
  const writes: Array<{ uri: string; content: string }> = []
  const fileService = {
    writeFile: vi.fn(async (uri: { toString(): string }, buf: { toString(): string }) => {
      writes.push({ uri: uri.toString(), content: buf.toString() })
    }),
  }
  return { fileService: fileService as unknown as IFileService, writes }
}

describe('inMemorySeedSource', () => {
  it('seeds every file under the default workspace root and returns the count', async () => {
    const { fileService, writes } = makeFileService()
    const source = inMemorySeedSource({ files: { 'app.json': '{}', 'pages/index.wxml': '<view/>' } })
    expect(source.folderUri).toBe('file:///workspace')
    expect(source.onSave).toBeUndefined()
    await expect(source.populate(fileService)).resolves.toBe(2)
    expect(writes).toEqual([
      { uri: 'file:///workspace/app.json', content: '{}' },
      { uri: 'file:///workspace/pages/index.wxml', content: '<view/>' },
    ])
  })

  it('honors a folderUri override and seeds nothing when no files/fetchUrl given', async () => {
    const { fileService, writes } = makeFileService()
    const source = inMemorySeedSource({ files: { 'a.js': '1' }, folderUri: 'file:///web' })
    await source.populate(fileService)
    expect(writes[0]!.uri).toBe('file:///web/a.js')

    const empty = inMemorySeedSource({})
    await expect(empty.populate(fileService)).resolves.toBe(0)
  })
})
