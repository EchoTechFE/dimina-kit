/**
 * The `/__fs` wire shapes, pinned at the point they are produced. What matters
 * to the browser side is what survives `JSON.stringify`, so the readdir cases
 * assert the serialized frame rather than the in-memory array.
 */
import { describe, expect, it } from 'vitest'

import { FS_TYPE_DIR, FS_TYPE_FILE, fsWatchFrame, toFsBridgeEntry } from './fs-bridge-protocol.js'

describe('toFsBridgeEntry', () => {
  it('sends a directory as the two-element shape, with no stat', () => {
    expect(toFsBridgeEntry({ name: 'pages', isDirectory: true })).toEqual(['pages', FS_TYPE_DIR])
  })

  it('sends a file with its size and mtime so the client can skip unchanged survivors', () => {
    expect(toFsBridgeEntry({ name: 'app.js', isDirectory: false, size: 12, mtimeMs: 1700 })).toEqual([
      'app.js',
      FS_TYPE_FILE,
      12,
      1700,
    ])
  })

  it('truncates a stat-less file entry instead of putting null on the wire', () => {
    // readdirWithin reports no size/mtime when the entry raced a concurrent
    // delete. A JSON array cannot hold a hole, so passing the values through
    // as `undefined` would serialize to `null` — which the client's
    // `size?: number` type does not admit.
    const raced = toFsBridgeEntry({ name: 'gone.js', isDirectory: false })
    expect(raced).toEqual(['gone.js', FS_TYPE_FILE])
    expect(JSON.stringify([raced])).toBe('[["gone.js",1]]')
  })

  it('truncates when only one of the two stats is missing', () => {
    expect(toFsBridgeEntry({ name: 'half.js', isDirectory: false, size: 3 })).toEqual(['half.js', FS_TYPE_FILE])
    expect(toFsBridgeEntry({ name: 'half.js', isDirectory: false, mtimeMs: 3 })).toEqual(['half.js', FS_TYPE_FILE])
  })

  it('keeps a zero size and a zero mtime, which are real values rather than missing ones', () => {
    expect(toFsBridgeEntry({ name: 'empty.js', isDirectory: false, size: 0, mtimeMs: 0 })).toEqual([
      'empty.js',
      FS_TYPE_FILE,
      0,
      0,
    ])
  })
})

describe('fsWatchFrame', () => {
  it('frames a change batch as one SSE event terminated by a blank line', () => {
    expect(fsWatchFrame({ paths: ['app.js', 'pages/index/index.wxml'] })).toBe(
      'data: {"paths":["app.js","pages/index/index.wxml"]}\n\n',
    )
  })

  it('frames the terminal watcher-dead notice the client falls back to a rescan on', () => {
    expect(fsWatchFrame({ watcherDead: true })).toBe('data: {"watcherDead":true}\n\n')
  })
})
