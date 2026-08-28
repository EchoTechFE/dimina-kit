/**
 * Runs the same self-contained 59-case mini-program page used by dimina-test
 * through a real DevTools compile, Service Host, Electron bridge, and WSS
 * transport. The Android capability branch matches Electron's native header
 * behavior: custom headers and duplicate values are supported, with no Origin.
 */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import {
  closeSecureWebSocketTestServer,
  createSecureWebSocketTestServer,
  secureWebSocketTestUrl,
  WEBSOCKET_TEST_CA_PATH,
  WEBSOCKET_TEST_CERT_SPKI,
} from '../../dimina-electron-runtime/e2e/fixtures/websocket-tls'
import {
  closeProject,
  evalInWebContentsByUrl,
  openProjectInUI,
  pollUntil,
  waitForSimulatorWebview,
  findMainWindow,
} from './helpers'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UPSTREAM_PAGE = path.resolve(
  HERE,
  '../../../dimina/fe/example/base/pages/socket-test',
)

interface ContractResult {
  name: string
  ok: boolean
  detail: string
}

interface ContractSnapshot {
  summary: string
  results: ContractResult[]
}

interface SocketStats {
  openCount: number
  closeCount: number
  live: number
  handshakes: Array<{
    url: string
    headers: Record<string, string | string[] | undefined>
  }>
}

interface AppHandle {
  app: ElectronApplication
  win: Page
}

function writeContractProject(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-devtools-socket-contract-'))
  const pageDir = path.join(projectDir, 'pages/socket-test')
  fs.mkdirSync(pageDir, { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'app.js'), 'App({})\n')
  fs.writeFileSync(path.join(projectDir, 'app.json'), JSON.stringify({
    pages: ['pages/socket-test/index'],
    window: { navigationBarTitleText: 'WebSocket Contract' },
  }, null, 2))
  fs.writeFileSync(path.join(projectDir, 'project.config.json'), JSON.stringify({
    appid: 'devtools_websocket_contract',
    projectname: 'devtools-websocket-contract',
  }, null, 2))
  for (const extension of ['js', 'wxml', 'wxss']) {
    fs.copyFileSync(
      path.join(UPSTREAM_PAGE, `index.${extension}`),
      path.join(pageDir, `index.${extension}`),
    )
  }
  return projectDir
}

function jsonResponse(response: import('node:http').ServerResponse, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body))
  response.writeHead(200, {
    'Content-Length': payload.byteLength,
    'Content-Type': 'application/json',
  })
  response.end(payload)
}

function createContractServer(stats: SocketStats): WebSocketServer {
  const server = createSecureWebSocketTestServer({
    handleProtocols(protocols) {
      return protocols.values().next().value ?? false
    },
    requestListener(request, response) {
      const pathname = String(request.url ?? '').split('?')[0]
      if (pathname.endsWith('/__stats')) {
        jsonResponse(response, stats)
        return
      }
      if (pathname.endsWith('/__reset')) {
        stats.openCount = 0
        stats.closeCount = 0
        stats.handshakes.length = 0
        jsonResponse(response, stats)
        return
      }
      response.writeHead(404)
      response.end()
    },
  })
  server.on('headers', (headers, request) => {
    if (request.url?.includes('dupHeader=1')) {
      headers.push('X-Dimina-Dup: first', 'X-Dimina-Dup: second')
    }
  })
  server.on('connection', (socket, request) => {
    stats.openCount += 1
    stats.live += 1
    stats.handshakes.push({
      url: request.url ?? '',
      headers: { ...request.headers },
    })
    let closed = false
    const markClosed = (): void => {
      if (closed) return
      closed = true
      stats.closeCount += 1
      stats.live -= 1
    }
    socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }))
    socket.once('close', markClosed)
    socket.once('error', markClosed)
  })
  return server
}

async function readContractSnapshot(app: ElectronApplication): Promise<ContractSnapshot | null> {
  return app.evaluate(async ({ webContents }) => {
    const guests = webContents.getAllWebContents().filter((contents) =>
      !contents.isDestroyed()
      && contents.getURL().includes('__frame__.html')
      && contents.getURL().includes('pages%2Fsocket-test%2Findex'))
    const guest = guests.at(-1)
    if (!guest || guest.isLoading()) return null
    return guest.executeJavaScript(`(() => {
      var summary = document.querySelector('.summary');
      var lines = Array.from(document.querySelectorAll('.log-line'));
      return {
        summary: summary ? summary.textContent.trim() : '',
        results: lines.map(function(line) {
          var text = line.textContent.trim();
          var ok = line.classList.contains('ok');
          var body = text.replace(/^[✅❌]\\s*/, '');
          var split = body.indexOf(' — ');
          return {
            name: split < 0 ? body : body.slice(0, split),
            ok: ok,
            detail: split < 0 ? '' : body.slice(split + 3),
          };
        }),
      };
    })()`)
  }) as Promise<ContractSnapshot | null>
}

async function bootApp(projectDir: string, userDataDir: string): Promise<AppHandle> {
  const appPath = path.resolve(HERE, 'electron-entry.js')
  const app = await _electron.launch({
    args: [
      appPath,
      'auto',
      '--auto-port',
      '0',
      `--ignore-certificate-errors-spki-list=${WEBSOCKET_TEST_CERT_SPKI}`,
      `--user-data-dir=${userDataDir}`,
    ],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      NODE_EXTRA_CA_CERTS: WEBSOCKET_TEST_CA_PATH,
      DIMINA_NATIVE_HOST: '1',
      DIMINA_E2E_USER_DATA_DIR: userDataDir,
    },
  })
  const win = await findMainWindow(app)
  await win.waitForLoadState('domcontentloaded')
  await openProjectInUI(win, projectDir, { waitMs: 20_000 })
  await waitForSimulatorWebview(app)
  await pollUntil(
    () => evalInWebContentsByUrl<boolean>(
      app,
      'service.html',
      `typeof wx !== 'undefined' && typeof wx.connectSocket === 'function'`,
    ).catch(() => false),
    Boolean,
    30_000,
    500,
  )
  return { app, win }
}

test.describe('DevTools runs the upstream WebSocket contract page', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(420_000)

  let projectDir = ''
  let userDataDir = ''
  let wss: WebSocketServer
  let socketUrl = ''
  let handle: AppHandle | undefined
  const stats: SocketStats = { openCount: 0, closeCount: 0, live: 0, handshakes: [] }

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    expect(fs.existsSync(path.join(UPSTREAM_PAGE, 'index.js'))).toBe(true)
    projectDir = writeContractProject()
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimina-devtools-socket-profile-'))
    wss = createContractServer(stats)
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve)
      wss.once('error', reject)
    })
    socketUrl = secureWebSocketTestUrl((wss.address() as AddressInfo).port)
    handle = await bootApp(projectDir, userDataDir)
  })

  test.afterAll(async () => {
    if (handle) {
      await closeProject(handle.win).catch(() => {})
      await handle.app.close().catch(() => {})
    }
    if (wss) {
      for (const socket of wss.clients) socket.terminate()
      await closeSecureWebSocketTestServer(wss)
    }
    if (projectDir) fs.rmSync(projectDir, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 })
    if (userDataDir) fs.rmSync(userDataDir, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 })
  })

  test('passes all 59 public API, routing, lifecycle, binary, handshake, and timeout cases', async () => {
    const runStarted = await evalInWebContentsByUrl<boolean>(
      handle!.app,
      'service.html',
      `(() => {
        var pages = getCurrentPages();
        var page = pages[pages.length - 1];
        if (!page || typeof page.runTests !== 'function') return false;
        page.setData({ wsUrl: ${JSON.stringify(socketUrl)}, e2ePlatform: 'android' });
        page.runTests();
        return true;
      })()`,
    )
    expect(runStarted).toBe(true)

    const snapshot = await pollUntil(
      () => readContractSnapshot(handle!.app),
      (state) => Boolean(state && /全部通过|存在失败|已中止/.test(state.summary)),
      360_000,
      1_000,
    )
    const failures = snapshot.results.filter((result) => !result.ok)
    expect(
      snapshot.summary,
      `contract failures: ${JSON.stringify(failures, null, 2)}`,
    ).toBe('全部通过 59/59')
    expect(snapshot.results).toHaveLength(59)
    expect(failures).toEqual([])
    expect(stats.live, 'the contract suite must release every server connection').toBe(0)
  })
})
