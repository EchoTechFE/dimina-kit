/**
 * Minimal JSON responder shared by the workbench COI server and its
 * `/__fs/watch` SSE module (fs-watch-sse.ts). Lives in its own module because
 * workbench-coi-server.ts imports fs-watch-sse.ts — either file owning it
 * would force an import cycle for the other.
 */
import type http from 'node:http'

export function jsonRes(res: http.ServerResponse, code: number, obj: unknown): void {
  const body = Buffer.from(JSON.stringify(obj))
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length })
  res.end(body)
}
