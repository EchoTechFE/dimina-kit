/**
 * `serveStaticFile` decides the response from a `stat` and only then opens a
 * read stream. Between the two the file can vanish or lose permissions, and
 * the stream reports that asynchronously — after the 200 and its
 * Content-Length are already on the wire, so no status can still be changed.
 * An unhandled 'error' on a stream is an uncaught exception in the main
 * process, which would take every project window down over one missing file,
 * so the stream's failure has to end as a destroyed socket instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

// Held in `vi.hoisted` because the mock factory below is hoisted above this
// file's own bindings and would read an ordinary `let` in its temporal dead
// zone. Only `createReadStream` is swapped, and only while a test asks for it:
// realpath/stat still hit the real filesystem, so the code under test takes
// its normal path up to the point where the stream fails.
const streamHook = vi.hoisted(() => ({ override: null as ((realFile: string) => PassThrough) | null }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const createReadStream = ((...args: unknown[]) =>
    streamHook.override
      ? streamHook.override(String(args[0]))
      : (actual.createReadStream as unknown as (...a: unknown[]) => unknown)(...args)) as typeof actual.createReadStream
  // `default` too: the module under test uses a default import of `node:fs`.
  const patched = { ...actual, createReadStream }
  return { ...patched, default: patched }
})

import { serveStaticFile } from './workbench-coi-static.js'

const FILE_BODY = 'the whole file body'

let tmpDir = ''
let server: http.Server | null = null
let port = 0

/** Outcome of one request, including whether the response reached its end. */
interface Outcome {
  status: number
  body: string
  /** False when the socket died before the declared body arrived. */
  completed: boolean
}

/**
 * A response truncated mid-body never emits 'end', so completion — not just
 * the status — is what a client can observe when the failure arrives after
 * the header is already sent. `onFirstChunk` runs once the client has really
 * received bytes, which is the only moment at which "the 200 is on the wire"
 * is a fact rather than an assumption.
 */
function get(rawPath: string, onFirstChunk?: () => void): Promise<Outcome> {
  return new Promise((resolve) => {
    // `agent: false`: a keep-alive socket left in the global agent's pool
    // would hold the test server open across the afterEach close.
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET', agent: false }, (res) => {
      const chunks: Buffer[] = []
      let first = true
      const settle = (completed: boolean) =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), completed })
      res.on('data', (c: Buffer) => {
        chunks.push(c)
        if (first) { first = false; onFirstChunk?.() }
      })
      res.on('end', () => settle(true))
      res.on('aborted', () => settle(false))
      res.on('error', () => settle(false))
    })
    // The socket can die before any header arrives; that is still a destroyed
    // response, not a test failure.
    req.on('error', () => resolve({ status: 0, body: '', completed: false }))
    req.end()
  })
}

beforeEach(async () => {
  streamHook.override = null
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coi-static-test-'))
  await fs.writeFile(path.join(tmpDir, 'asset.txt'), FILE_BODY)
  server = http.createServer((req, res) => {
    serveStaticFile(res, tmpDir, new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
  port = (server!.address() as net.AddressInfo).port
})

afterEach(async () => {
  streamHook.override = null
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('serveStaticFile with a healthy file', () => {
  it('streams the whole body with the stat size as Content-Length', async () => {
    const res = await get('/asset.txt')

    expect(res.status).toBe(200)
    expect(res.body).toBe(FILE_BODY)
    expect(res.completed).toBe(true)
  })
})

describe('the read stream fails after the response header is already sent', () => {
  it('destroys the response instead of letting the error go unhandled, and keeps serving', async () => {
    // Content-Length was taken from the stat, so a body cut short here is
    // exactly what a client sees when the file is unlinked or chmod'ed away
    // between the stat and the read.
    let injected: PassThrough | null = null
    streamHook.override = () => {
      injected = new PassThrough()
      injected.write('part')
      return injected
    }

    const outcome = await get('/asset.txt', () => {
      // Raised from the socket's data callback, i.e. asynchronously, the way
      // the fs layer reports a late failure: with no listener on the stream
      // this is an uncaught exception rather than a caught error.
      injected!.emit('error', new Error('EBADF: bad file descriptor'))
    })

    expect(outcome.status).toBe(200)
    expect(outcome.body).toBe('part')
    expect(outcome.completed).toBe(false)

    // The listener is shared by every project window, so surviving the
    // failure — not just answering it — is the invariant.
    streamHook.override = null
    const after = await get('/asset.txt')
    expect(after.status).toBe(200)
    expect(after.body).toBe(FILE_BODY)
  })
})

describe('the read stream fails before any body byte is written', () => {
  it('destroys the response rather than leaving the client waiting for a body that never comes', async () => {
    // A file that stats but cannot be opened: the error arrives before any
    // data, so the client never sees a complete response either way — what
    // must not happen is the request hanging until its own timeout while the
    // main process dies of an unhandled 'error'.
    streamHook.override = () => {
      const stream = new PassThrough()
      setImmediate(() => stream.emit('error', new Error('EACCES: permission denied')))
      return stream
    }

    const outcome = await get('/asset.txt')
    expect(outcome.completed).toBe(false)
    expect(outcome.body).not.toBe(FILE_BODY)

    streamHook.override = null
    const after = await get('/asset.txt')
    expect(after.status).toBe(200)
    expect(after.body).toBe(FILE_BODY)
  })
})
