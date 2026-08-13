import { createHash, X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import {
  createServer,
  type RequestListener,
  type Server as HttpsServer,
} from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type ServerOptions } from 'ws'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TLS_DIR = path.join(HERE, 'websocket-tls')

export const WEBSOCKET_TEST_CA_PATH = path.join(TLS_DIR, 'localhost-cert.fixture')
export const WEBSOCKET_TEST_TLS = {
  cert: fs.readFileSync(WEBSOCKET_TEST_CA_PATH),
  key: fs.readFileSync(path.join(TLS_DIR, 'localhost-key.fixture')),
}
export const WEBSOCKET_TEST_CERT_SPKI = createHash('sha256')
  .update(new X509Certificate(WEBSOCKET_TEST_TLS.cert).publicKey.export({ format: 'der', type: 'spki' }))
  .digest('base64')

const secureServers = new WeakMap<WebSocketServer, HttpsServer>()

export interface SecureWebSocketTestServerOptions
  extends Omit<ServerOptions, 'host' | 'port' | 'server'> {
  requestListener?: RequestListener
}

export function createSecureWebSocketTestServer(
  options: SecureWebSocketTestServerOptions = {},
): WebSocketServer {
  const { requestListener, ...webSocketOptions } = options
  const server = createServer(WEBSOCKET_TEST_TLS, requestListener)
  const webSocketServer = new WebSocketServer({ ...webSocketOptions, server })
  secureServers.set(webSocketServer, server)
  server.listen(0, '127.0.0.1')
  return webSocketServer
}

export async function closeSecureWebSocketTestServer(webSocketServer: WebSocketServer): Promise<void> {
  const server = secureServers.get(webSocketServer)
  await new Promise<void>((resolve) => webSocketServer.close(() => resolve()))
  if (server?.listening) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  secureServers.delete(webSocketServer)
}

export function secureWebSocketTestUrl(port: number, pathname = '/socket'): string {
  return `wss://127.0.0.1:${port}${pathname}`
}
