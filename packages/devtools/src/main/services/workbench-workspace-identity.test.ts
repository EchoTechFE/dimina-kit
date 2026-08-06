/**
 * Per-project workspace identity for the embedded VS Code workbench, served at
 * the COI server's `/__project`.
 *
 * The workbench mirrors EVERY project at the same constant `file:///workspace`
 * root (the web tsserver needs a real `file://` project root), and VS Code
 * derives a window's workspace identity — the key of its WORKSPACE-scope
 * IndexedDB bucket, which holds `editorpart.state` (open tabs), view state and
 * explorer expansion — from that folder URI. One constant URI therefore means
 * ONE bucket shared by every project: project A's tabs get restored into
 * project B, each stranded behind a permanent "file was not found" placeholder.
 *
 * The fix names the workspace after the miniapp instead. The identity is served
 * over HTTP rather than baked into the workbench's load URL because the editor
 * view can attach BEFORE the project session commits (the attach gate self-
 * releases after a 3s cap on a slow compile, and its release fires just ahead
 * of the commit) — a URL query would be empty exactly when a cold project open
 * needs it. `/__project` is read per request, so the page can poll it the same
 * way the disk mirror already polls `/__fs` for the project root to appear.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// The COI server pulls in `electron` transitively (project-fs → ipc-registry's
// top-level `import { ipcMain } from 'electron'`). A no-op stub is enough.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), off: vi.fn() } }))

import { startWorkbenchCoiServer, type WorkbenchCoiServer } from './workbench-coi-server.js'

let tmpParent = ''
let rootDir = ''
let server: WorkbenchCoiServer | null = null

/** The `/__project` payload: the page's view of the active project identity. */
interface ProjectIdentityBody {
  workspaceId?: string | null
}

async function startWith(
  getProjectIdentity?: () => { appId: string | null; projectPath: string },
): Promise<WorkbenchCoiServer> {
  return startWorkbenchCoiServer({
    rootDir,
    getProjectRoot: () => '',
    getProjectIdentity,
  })
}

async function readWorkspaceId(
  getProjectIdentity?: () => { appId: string | null; projectPath: string },
): Promise<string | null | undefined> {
  server = await startWith(getProjectIdentity)
  const res = await fetch(`${server.baseUrl}__project`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as ProjectIdentityBody
  await server.close()
  server = null
  return body.workspaceId
}

beforeEach(async () => {
  tmpParent = await fs.mkdtemp(path.join(os.tmpdir(), 'coi-workspace-id-'))
  rootDir = path.join(tmpParent, 'bundle')
  await fs.mkdir(rootDir, { recursive: true })
  await fs.writeFile(path.join(rootDir, 'index.html'), '<!doctype html>ok')
  server = null
})

afterEach(async () => {
  if (server) {
    await server.close()
    server = null
  }
  await fs.rm(tmpParent, { recursive: true, force: true })
})

describe('COI /__project: the workbench workspace is named after the miniapp', () => {
  it('reports a workspaceId built from the active project appId', async () => {
    const id = await readWorkspaceId(() => ({ appId: 'wxappTABBAR', projectPath: '/projects/tabbar' }))

    expect(id).toBeTruthy()
    // Human-legible: the miniapp's own id leads the workspace name, so a
    // `vscode-web-state-db-<id>` bucket can be traced back to its project.
    expect(id!.startsWith('wxappTABBAR')).toBe(true)
  })

  it('gives two different miniapps two different workspace ids', async () => {
    // This is the whole point: distinct ids ⇒ distinct WORKSPACE-scope storage
    // buckets ⇒ project A's open tabs can never be restored into project B.
    const a = await readWorkspaceId(() => ({ appId: 'wxappTABBAR', projectPath: '/projects/tabbar' }))
    const b = await readWorkspaceId(() => ({ appId: 'wxappQDML', projectPath: '/projects/qdml' }))

    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    expect(a).not.toBe(b)
  })

  it('separates the same appId opened from two different directories', async () => {
    // appId comes from the project manifest, so a copied project declares the
    // same one; folding the path in keeps those two checkouts isolated.
    const a = await readWorkspaceId(() => ({ appId: 'wxappSAME', projectPath: '/projects/alpha' }))
    const b = await readWorkspaceId(() => ({ appId: 'wxappSAME', projectPath: '/projects/beta' }))

    expect(a).not.toBe(b)
  })

  it('reuses the same id for the same project, so its tabs come back', async () => {
    const identity = () => ({ appId: 'wxappTABBAR', projectPath: '/projects/tabbar' })
    const first = await readWorkspaceId(identity)
    const second = await readWorkspaceId(identity)

    expect(first).toBeTruthy()
    expect(first).toBe(second)
  })

  it('reports a null workspaceId while no project session is committed', async () => {
    // The page polls until this turns non-null; a project id must never be
    // invented from a half-open project.
    const id = await readWorkspaceId(() => ({ appId: null, projectPath: '' }))

    expect(id).toBeNull()
  })

  it('reports a null workspaceId when the host wired no identity source', async () => {
    const id = await readWorkspaceId(undefined)

    expect(id).toBeNull()
  })

  it('re-reads the identity per request, so a project switch is picked up', async () => {
    // One long-lived server spans every project open: a value captured at
    // startup would pin the editor to the first project forever.
    let current = { appId: 'wxappFIRST' as string | null, projectPath: '/projects/first' }
    server = await startWith(() => current)

    const first = (await (await fetch(`${server.baseUrl}__project`)).json()) as ProjectIdentityBody
    current = { appId: 'wxappSECOND', projectPath: '/projects/second' }
    const second = (await (await fetch(`${server.baseUrl}__project`)).json()) as ProjectIdentityBody

    expect(first.workspaceId).toBeTruthy()
    expect(second.workspaceId).toBeTruthy()
    expect(second.workspaceId).not.toBe(first.workspaceId)
  })
})
