/**
 * In-memory workspace source: seed a fixed `{ [relPath]: content }` file map
 * into the `file:///workspace` memfs, with no save-back. This is the web IDE's
 * file source — the project lives entirely in the browser; saves stay in memfs
 * (no disk to flush to).
 */
import type { IFileService } from '@codingame/monaco-vscode-api'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { VSBuffer } from '@codingame/monaco-vscode-api/vscode/vs/base/common/buffer'
import type { WorkspaceSource } from './types'

const DEFAULT_ROOT = 'file:///workspace'

export interface InMemorySeedOptions {
  /** Seed files directly: `{ 'pages/index.wxml': '<view/>' }`. */
  files?: Record<string, string>
  /** Or fetch the seed map (a JSON object of relPath→content) from this URL. */
  fetchUrl?: string
  /** Override the workspace folder URI (default `file:///workspace`). */
  folderUri?: string
}

export function inMemorySeedSource(opts: InMemorySeedOptions): WorkspaceSource {
  const folderUri = opts.folderUri ?? DEFAULT_ROOT
  return {
    folderUri,
    async populate(fileService: IFileService): Promise<number> {
      const files =
        opts.files ??
        (opts.fetchUrl ? ((await fetch(opts.fetchUrl).then((r) => r.json())) as Record<string, string>) : {})
      let n = 0
      for (const [rel, content] of Object.entries(files)) {
        await fileService.writeFile(URI.parse(`${folderUri}/${rel}`), VSBuffer.fromString(content))
        n++
      }
      return n
    },
  }
}
