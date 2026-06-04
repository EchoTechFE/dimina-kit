# Native Runtime PoC

Phase 0 spike for replacing the simulator's `dimina/fe/packages/container` (Application/MiniApp/Bridge/JSCore/WebView) + Web Worker host with an Electron native host. The PoC keeps the built `@dimina/service` and `@dimina/render` bundles **unchanged** and implements the native bridge in this directory.

## Status: ✅ PoC complete (2026-05-27)

Full hello-world lifecycle works end-to-end:

```
container loadResource ─┐
                        ├→ service modRequire/createApp → serviceResourceLoaded ─┐
                        └→ render loader (CSS/JS via HTTP) → renderResourceLoaded ┴→ resourceLoaded
                                                                                    ↓
                                                                          service firstRender
                                                                                    ↓
                                                                          render renders page
                                                                                    ↓
                                                                          render domReady → pageReady
```

## Validated core assumptions

| Assumption | Result | Evidence |
|---|---|---|
| `@dimina/service` bundle auto-detects `isWebWorker===false` in Electron BrowserWindow | ✅ | `[service] init` log without modifying bundle; `DiminaServiceBridge.invoke` hits preload |
| `@dimina/render` bundle works inside webview when `DiminaRenderBridge` is injected | ✅ | `[render] init` + `renderResourceLoaded` emitted |
| `DiminaServiceBridge.{invoke, publish, onMessage}` injection compatible with service bundle | ✅ | service-host preload setter trace shows it triggered, message loop works |
| Bridge envelope `{ type, target, body }` matches dimina-fe protocol | ✅ | service ↔ render messages routed end-to-end with no protocol-level errors |
| Logic.js can be injected to service's AMD registry via `executeJavaScript` before `loadResource` | ✅ | service `modRequire('app')`/`modRequire(pagePath)` resolve without "module not found" |
| Service + render survive contextIsolation:false sharing realm with preload | ✅ | bridge globals visible from bundle main-world code |

## 7 engineering pitfalls encountered (and how they were resolved)

1. **`package.json "type": "module"` breaks preload** — Electron preloads must be CJS. Solution: name preloads `.cjs`. *(`dist/service-host/preload.cjs`, `dist/render-host/preload.cjs`)*
2. **Vite build outputs absolute `/assets/...` URLs** — `file://` loading fails because chromium resolves to filesystem root. Solution: rewrite to `./assets/...` (production: vite `base: './'`).
3. **Webview preload runs in an isolated world by default** — `window.DiminaRenderBridge` injected by preload was invisible to render bundle. Solution: main process `will-attach-webview` event sets `webPreferences.contextIsolation = false`.
4. **`<link>` and `<script>` elements don't fire `onload` for `dimina-app://` custom protocol** — even though `fetch()` works. Solution: serve resources via in-process Node `http.createServer` listening on `http://127.0.0.1:<port>/`. Mirrors what production code will need anyway (dimina iOS uses `WKURLSchemeHandler`, Android uses `WebViewAssetLoader`, Electron equivalent is a localhost HTTP server or a custom scheme + custom resource loader).
5. **Custom protocol registered on default session doesn't apply to webview partition session** — `protocol.handle()` registers on default session only. Solution if you do use custom protocol: also register on `session.fromPartition(partitionName).protocol.handle(...)`.
6. **Pre-importing `@dimina/common` to expose `modDefine`/`modRequire` creates a disconnected AMD registry** — service bundle's internal `loader.modRequire` operates on a different `JSModules` closure than `globalThis.modDefine` reads from. Solution: load service bundle as plain `<script src>` (not ESM dynamic import); service's `env.js` installs `globalThis.modDefine` / `modRequire` referring to the service IIFE's own registry, which is then shared with `logic.js` (injected after via `executeJavaScript`).
7. **Synchronous `pendingMessages` drain races with module-level listener registration** — `DiminaServiceBridge.onMessage = handler` is set inside `message.js` at module top level; the very next module to import (`Render` / `Service` class) registers `message.on('loadResource', cb)` *after* that — but our preload's setter immediately drained any buffered `loadResource` messages, emitting into an empty mitt bus and silently dropping the first frame. Solution: `queueMicrotask(() => drain())` so the synchronous module-evaluation chain completes before the first message is dispatched.

These 7 fixes are all required for the production-grade host. Treat this README as the project's reference for the production implementation.

## Prerequisites

From the repository root, build the dimina/fe runtime bundles first:

```bash
cd dimina/fe
pnpm install
pnpm build:dev
```

Produces:
- `packages/common/dist/common.js`
- `packages/service/dist/service.js` (IIFE, no sourcemap — upstream PR opportunity)
- `packages/render/dist/render.js`

## Build And Start

This spike uses the repository root's `node_modules/electron` (41.2.1). It is **not** installable as a standalone package in this offline environment.

```bash
cd packages/devtools/_spike/native-runtime
# build (TypeScript + vite for the React simulator window)
pnpm run build
# launch with the repository root's electron
cd ../../../..   # back to worktree root
./node_modules/.bin/electron packages/devtools/_spike/native-runtime/dist/main.js
```

When the simulator window opens, the hidden service window's DevTools (detached) opens too along with the render webview's. The hello world page should appear.

## Manual Acceptance (Phase 0)

1. ✅ Simulator renders the hello world page (visible after the protocol/HTTP server fix + microtask drain fix landed)
2. (⏸ GUI) Tap → service `handleTap` → setData → render count update (next iteration)
3. ✅ Service window opens DevTools automatically
4. (⏸ GUI) `wx.getSystemInfo({ success: r => console.log(r) })` in service DevTools console returns real data
5. (⏸ GUI) Sources panel can break in the service bundle and step into

The remaining `⏸ GUI` items only require manual interaction with the running app — the architecture is in place to support them.

## Key files

| File | Role |
|---|---|
| `dist/main.js` | Electron entry: starts HTTP resource server, BridgeRouter, simulator window |
| `dist/bridge-router.js` | Per-bridge session table + service↔render forwarding + container message handling |
| `dist/service-host/preload.cjs` | Injects `DiminaServiceBridge` into hidden BrowserWindow before service bundle loads |
| `dist/render-host/preload.cjs` | Injects `DiminaRenderBridge` into webview |
| `dist/service-host/sync-api-patch.js` | After service bundle loads, patches `wx.*Sync` with local implementations |
| `src/service-host/service.html` | `<script src="@dimina/service">` + sync-api-patch loader |
| `src/render-host/pageFrame.html` | `<script type="module">` loads `@dimina/common` + `@dimina/render`, exposes `window.modDefine/modRequire` |
| `hello-world/` | Test fixture: handwritten AMD logic.js + Vue-shaped pages_index_index.js + CSS |

## Next: lift to production

This PoC ends here. The proper landing code goes under `packages/devtools/src/{service-host,render-host,main/ipc/bridge-router}`. The 7 pitfalls + their fixes above must be reproduced in the production code.
