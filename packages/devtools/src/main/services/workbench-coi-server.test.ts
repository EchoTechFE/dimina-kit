/**
 * Security hardening of the workbench COI server's `/__fs` project bridge and
 * `/__contrib` extension server. These tests run against the REAL filesystem
 * (symlink containment cannot be exercised through mocks) and assert the
 * sandbox invariants that keep an in-renderer workbench — or any localhost
 * page — from reading or mutating files outside the active project root.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startWorkbenchCoiServer, type WorkbenchCoiServer } from './workbench-coi-server.js'

let tmpParent = ''
let rootDir = ''
let projectRoot = ''
let outsideDir = ''
let activeProjectRoot = ''
let server: WorkbenchCoiServer | null = null

function startWith(opts: {
  getProjectRoot?: () => string
  extensionsDir?: string
}): Promise<WorkbenchCoiServer> {
  return startWorkbenchCoiServer({
    rootDir,
    getProjectRoot: opts.getProjectRoot ?? (() => activeProjectRoot),
    extensionsDir: opts.extensionsDir,
  })
}

beforeEach(async () => {
  // A single mkdtemp parent for both the project root and the "outside" secret
  // dir, so both live under the same realpath'd ancestor; assertions check
  // status + content leakage, never exact path strings (macos /tmp is itself a
  // symlink, which the server realpath's away).
  tmpParent = await fs.mkdtemp(path.join(os.tmpdir(), 'coi-test-'))
  rootDir = path.join(tmpParent, 'bundle')
  projectRoot = path.join(tmpParent, 'project')
  outsideDir = path.join(tmpParent, 'outside')
  await fs.mkdir(rootDir, { recursive: true })
  await fs.mkdir(projectRoot, { recursive: true })
  await fs.mkdir(outsideDir, { recursive: true })
  // Static bundle needs an index.html so the server has something to serve.
  await fs.writeFile(path.join(rootDir, 'index.html'), '<!doctype html>ok')
  activeProjectRoot = projectRoot
  server = null
})

afterEach(async () => {
  if (server) {
    await server.close()
    server = null
  }
  await fs.rm(tmpParent, { recursive: true, force: true })
})

describe('symlink containment on /__fs', () => {
  it('refuses to read a file through a symlink that points outside the root', async () => {
    const secret = path.join(outsideDir, 'secret.txt')
    await fs.writeFile(secret, 'SECRET')
    await fs.symlink(secret, path.join(projectRoot, 'link'))

    server = await startWith({})
    const res = await fetch(`${server.baseUrl}__fs/read?p=link`)

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(res.status).toBe(403)
    const body = await res.text()
    expect(body).not.toContain('SECRET')
  })

  it('refuses to stat a file through an out-of-root symlink', async () => {
    const secret = path.join(outsideDir, 'secret.txt')
    await fs.writeFile(secret, 'SECRET')
    await fs.symlink(secret, path.join(projectRoot, 'link'))

    server = await startWith({})
    const res = await fetch(`${server.baseUrl}__fs/stat?p=link`)

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    const body = await res.text()
    expect(body).not.toContain('"size"')
  })

  it('refuses to write through a symlinked-out parent directory', async () => {
    await fs.symlink(outsideDir, path.join(projectRoot, 'escdir'))

    server = await startWith({})
    const res = await fetch(`${server.baseUrl}__fs/write?p=escdir/x.txt`, {
      method: 'POST',
      body: Buffer.from('payload'),
    })

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    // The write must not have leaked a file into the outside dir.
    await expect(fs.stat(path.join(outsideDir, 'x.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('reads and writes a normal in-root file (positive control)', async () => {
    server = await startWith({})

    const writeRes = await fetch(`${server.baseUrl}__fs/write?p=note.txt`, {
      method: 'POST',
      body: Buffer.from('hello world'),
    })
    expect(writeRes.status).toBe(204)

    const readRes = await fetch(`${server.baseUrl}__fs/read?p=note.txt`)
    expect(readRes.status).toBe(200)
    expect(await readRes.text()).toBe('hello world')

    // The bytes actually landed on disk inside the root.
    expect(await fs.readFile(path.join(projectRoot, 'note.txt'), 'utf8')).toBe('hello world')
  })
})

describe('method + origin guard on mutating /__fs actions', () => {
  it('rejects a mutating action issued over GET with 405 and changes nothing', async () => {
    await fs.writeFile(path.join(projectRoot, 'foo.txt'), 'keep')

    server = await startWith({})
    const res = await fetch(`${server.baseUrl}__fs/write?p=foo.txt`)

    expect(res.status).toBe(405)
    expect(await fs.readFile(path.join(projectRoot, 'foo.txt'), 'utf8')).toBe('keep')
  })

  it('rejects delete over GET with 405 and leaves the file in place', async () => {
    await fs.writeFile(path.join(projectRoot, 'foo.txt'), 'keep')

    server = await startWith({})
    const res = await fetch(`${server.baseUrl}__fs/delete?p=foo.txt`)

    expect(res.status).toBe(405)
    await expect(fs.stat(path.join(projectRoot, 'foo.txt'))).resolves.toBeTruthy()
  })

  it('rejects a POST delete from a cross-origin Origin with 403 and keeps the file', async () => {
    await fs.writeFile(path.join(projectRoot, 'foo.txt'), 'keep')

    server = await startWith({})
    const res = await fetch(`${server.baseUrl}__fs/delete?p=foo.txt`, {
      method: 'POST',
      headers: { Origin: 'http://evil.example' },
    })

    expect(res.status).toBe(403)
    await expect(fs.stat(path.join(projectRoot, 'foo.txt'))).resolves.toBeTruthy()
  })

  it('allows an origin-less POST delete (the workbench own fetch)', async () => {
    await fs.writeFile(path.join(projectRoot, 'foo.txt'), 'keep')

    server = await startWith({})
    const res = await fetch(`${server.baseUrl}__fs/delete?p=foo.txt`, {
      method: 'POST',
    })

    expect(res.status).toBe(204)
    await expect(fs.stat(path.join(projectRoot, 'foo.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects a POST write tagged Sec-Fetch-Site: cross-site with 403', async () => {
    server = await startWith({})
    const res = await fetch(`${server.baseUrl}__fs/write?p=cross.txt`, {
      method: 'POST',
      headers: { 'Sec-Fetch-Site': 'cross-site' },
      body: Buffer.from('nope'),
    })

    expect(res.status).toBe(403)
    await expect(fs.stat(path.join(projectRoot, 'cross.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('request body size limit on /__fs/write', () => {
  it('rejects a body larger than 32MB with 413 and writes nothing', async () => {
    server = await startWith({})
    // Slightly over the 32 MiB cap.
    const oversized = Buffer.alloc(32 * 1024 * 1024 + 64, 0x61)

    const res = await fetch(`${server.baseUrl}__fs/write?p=big.bin`, {
      method: 'POST',
      body: oversized,
    })

    expect(res.status).toBe(413)
    await expect(fs.stat(path.join(projectRoot, 'big.bin'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('no active project', () => {
  it('responds 409 to readdir so the provider stays empty rather than erroring', async () => {
    server = await startWith({ getProjectRoot: () => '' })
    const res = await fetch(`${server.baseUrl}__fs/readdir?p=.`)
    expect(res.status).toBe(409)
  })
})

describe('symlink containment on /__contrib', () => {
  it('serves a valid extension file but refuses an out-of-root symlink', async () => {
    const extDir = path.join(tmpParent, 'extensions')
    const ext = path.join(extDir, 'ext')
    await fs.mkdir(ext, { recursive: true })
    await fs.writeFile(
      path.join(ext, 'package.json'),
      JSON.stringify({ name: 'ext', version: '0.0.1' }),
    )
    const secret = path.join(outsideDir, 'contrib-secret.txt')
    await fs.writeFile(secret, 'SECRET')
    await fs.symlink(secret, path.join(ext, 'leak.txt'))

    server = await startWith({ extensionsDir: extDir })

    const leakRes = await fetch(`${server.baseUrl}__contrib/ext/leak.txt`)
    expect(leakRes.status).not.toBe(200)
    expect([403, 404]).toContain(leakRes.status)
    expect(await leakRes.text()).not.toContain('SECRET')

    const pkgRes = await fetch(`${server.baseUrl}__contrib/ext/package.json`)
    expect(pkgRes.status).toBe(200)
    expect(await pkgRes.text()).toContain('"name":"ext"')
  })
})
