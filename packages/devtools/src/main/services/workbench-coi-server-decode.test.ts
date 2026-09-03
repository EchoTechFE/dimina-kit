/**
 * Which layer answers a malformed request path.
 *
 * A window's bridge is a route on a listener shared with every other project
 * window, and that listener wraps the route in an exception boundary it cannot
 * see through: a throw arriving there could be anything, so it can only log it
 * and answer 500. A stray `%` in a path is not that — it is the client's own
 * mistake, recognizable as such only inside the handler that decodes it. So
 * the handler decodes and answers 400 itself, and a 500 (or a logged throw)
 * for one of these paths would mean the layering broke.
 *
 * Split from workbench-coi-server.test.ts to keep both files under the
 * file-length gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

// The COI server pulls in `electron` transitively (project-fs → ipc-registry's
// top-level `import { ipcMain } from 'electron'`). CI has no Electron binary, so
// the unmocked import throws at module-eval. The server never touches ipcMain;
// a no-op stub is enough to let the module load.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), off: vi.fn() } }))

import { startWorkbenchCoiServer, type WorkbenchCoiServer } from './workbench-coi-server.js'
import { closeAllCoiHosts } from './workbench-coi-host.js'

let tmpParent = ''
let server: WorkbenchCoiServer | null = null

/**
 * Sends the exact wire path given: `fetch` will not carry a lone '%' through
 * to the request line the way a crafted client does.
 */
function rawGet(port: number, rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    req.end()
  })
}

beforeEach(async () => {
  tmpParent = await fs.mkdtemp(path.join(os.tmpdir(), 'coi-decode-test-'))
  await fs.mkdir(path.join(tmpParent, 'bundle'), { recursive: true })
  await fs.mkdir(path.join(tmpParent, 'extensions'), { recursive: true })
  await fs.writeFile(path.join(tmpParent, 'bundle', 'index.html'), '<!doctype html>ok')
  server = null
})

afterEach(async () => {
  if (server) {
    await server.close()
    server = null
  }
  // A window's close deliberately leaves the shared listener up, so it takes a
  // separate call to release the port between tests.
  await closeAllCoiHosts()
  await fs.rm(tmpParent, { recursive: true, force: true })
})

describe('malformed percent-encoding on a static path inside the window prefix', () => {
  it('answers 400 from the handler itself, without reaching the shared listener boundary', async () => {
    server = await startWorkbenchCoiServer({
      rootDir: path.join(tmpParent, 'bundle'),
      getProjectRoot: () => '',
      // Set so `/__contrib/` reaches its static-file branch; with no
      // extensions dir it would 404 before decoding anything.
      extensionsDir: path.join(tmpParent, 'extensions'),
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const prefix = new URL(server.baseUrl).pathname
      // The two paths the handler decodes: contributed extension files and the
      // workbench bundle fallback.
      for (const suffix of ['%', '__contrib/%']) {
        const res = await rawGet(server.port, prefix + suffix)
        expect(res.status).toBe(400)
        expect(res.body).toBe('Bad Request')
      }
      // A 500, or anything logged, would mean the throw escaped to the shared
      // listener, which cannot tell a bad request from a bug in this handler.
      expect(logged).not.toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })

  it('keeps serving well-formed paths on the same window after a rejected one', async () => {
    server = await startWorkbenchCoiServer({
      rootDir: path.join(tmpParent, 'bundle'),
      getProjectRoot: () => '',
    })
    const prefix = new URL(server.baseUrl).pathname

    expect((await rawGet(server.port, `${prefix}%`)).status).toBe(400)

    const ok = await rawGet(server.port, `${prefix}index.html`)
    expect(ok.status).toBe(200)
    expect(ok.body).toBe('<!doctype html>ok')
  })
})
