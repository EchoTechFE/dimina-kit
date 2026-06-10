/**
 * Wires the `difile://_tmp/*` protocol handler on the simulator session
 * and bridges renderer-side `setTempFileSink` callbacks to the main-process
 * byte store. Returned disposable clears the store, unregisters the protocol
 * handler, and tears down its private IPC channels.
 *
 * SENDER POLICY: The default workbench sender-policy intentionally rejects
 * the simulator `<webview>` (see `utils/sender-policy.ts`). The simulator
 * is the only legitimate writer for these channels, so this module installs
 * its own narrow policy that accepts a sender only when its WebContents
 * belongs to the simulator `Session` we were handed. This bypasses the
 * default policy without widening trust to any other source.
 *
 * WRITE-vs-RENDER RACE: `createTempFilePath` is synchronous on the renderer,
 * but the bytes travel here through `blob.arrayBuffer().then(ipcRenderer.send)`
 * — async. The simulator can race ahead: in `chooseMedia` the renderer
 * assigns `img.src = tempFilePath` (via `readImageMetadata`) immediately
 * after `createTempFilePath` returns, which fires a `difile://` GET before
 * our IPC write arrives. The protocol handler therefore parks a request on
 * a per-url waiter for up to PENDING_TIMEOUT_MS; the IPC `write` handler
 * drains the waiter on arrival.
 *
 * QUOTA: A single in-memory store backs all simulator sessions for the
 * lifetime of the WorkbenchApp instance. We cap it at MAX_STORE_ENTRIES
 * (FIFO eviction). Project switches do NOT clear the store on their own —
 * stale entries from a previous project simply age out as new ones land.
 * This is the same eviction shape WeChat uses for tmp files (LRU under a
 * size cap), simplified for a dev-tools session scope.
 */

import type { Session } from 'electron'
import { IpcRegistry, type SenderPolicy } from '../../utils/ipc-registry.js'
import { toDisposable, type Disposable } from '@dimina-kit/electron-deck/main'
import { type TempFileStore } from './resolver.js'
import { registerTempFile, revokeTempFile, revokeAllTempFiles } from './store.js'
import { handleDifileRequest } from './request-handler.js'
import { registerMiniappSessionConfigurator } from '../views/miniapp-partition.js'
import {
	handleFsMkdir,
	handleFsRead,
	handleFsReaddir,
	handleFsStat,
	handleFsUnlink,
	handleFsWrite,
} from './fs-channels.js'

/** Upper bound for in-memory entries; oldest insertion is evicted (FIFO). */
const MAX_STORE_ENTRIES = 200

/** Max time the protocol handler waits for an in-flight `write` IPC. */
const PENDING_TIMEOUT_MS = 500

function enforceStoreCap(store: TempFileStore): void {
	while (store.size > MAX_STORE_ENTRIES) {
		const next = store.keys().next()
		if (next.done) break
		store.delete(next.value)
	}
}

export function setupSimulatorTempFiles(simSession: Session): Disposable {
	const store: TempFileStore = new Map()
	const pendingWaiters = new Map<string, Set<() => void>>()
	let disposed = false

	function drainWaiters(path: string): void {
		const list = pendingWaiters.get(path)
		if (!list) return
		pendingWaiters.delete(path)
		for (const fn of list) fn()
	}

	function drainAllWaiters(): void {
		const lists = Array.from(pendingWaiters.values())
		pendingWaiters.clear()
		for (const list of lists) for (const fn of list) fn()
	}

	// The protocol handler + IPC channels are shared across every per-project
	// miniapp partition session (each project's render/service runs the same
	// difile:// + temp-file FSM). The base session is always trusted; additional
	// per-project partition sessions register themselves via `installOnSession`.
	const trustedSessions = new Set<Session>([simSession])
	const simulatorOnlyPolicy: SenderPolicy = sender =>
		!sender.isDestroyed() && trustedSessions.has(sender.session)

	const registry = new IpcRegistry(simulatorOnlyPolicy)

	registry.on('simulator:temp-file:write', (_event, payload) => {
		if (disposed) return
		const { path, mime, bytes } = payload as {
			path: string
			mime: string
			bytes: ArrayBuffer | Uint8Array | Buffer
		}
		registerTempFile(store, path, mime, bytes as ArrayBuffer | Buffer)
		enforceStoreCap(store)
		drainWaiters(path)
	})

	registry.on('simulator:temp-file:revoke', (_event, payload) => {
		if (disposed) return
		const { path } = payload as { path: string }
		revokeTempFile(store, path)
	})

	registry.on('simulator:temp-file:revoke-all', () => {
		if (disposed) return
		revokeAllTempFiles(store)
	})

	const difileHandler = async (req: { url: string; headers: { forEach: (cb: (v: string, k: string) => void) => void } }): Promise<Response> => {
		const url = req.url
		// Forward any HTTP headers Electron parsed (Range / If-None-Match)
		// to the pure dispatcher so it can do its own conditional / range
		// shaping.
		const headers: Record<string, string> = {}
		try {
			req.headers.forEach((v, k) => { headers[k] = v })
		}
		catch {
			// Older Electron headers shape may not be iterable — best effort.
		}
		const ctx = { tempStore: store }
		let res = await handleDifileRequest(ctx, { url, headers })

		// Race waiter: the renderer-side `createTempFilePath` is synchronous
		// but its `bytes` IPC arrives later. If we miss a `_tmp/*` lookup,
		// park briefly and retry once.
		if (
			res.status === 404
			&& !disposed
			&& url.startsWith('difile://_tmp/')
		) {
			await new Promise<void>((resolve) => {
				let timer: ReturnType<typeof setTimeout> | null = null
				const notify = (): void => {
					if (timer) clearTimeout(timer)
					resolve()
				}
				const list = pendingWaiters.get(url) ?? new Set<() => void>()
				list.add(notify)
				pendingWaiters.set(url, list)
				timer = setTimeout(() => {
					const cur = pendingWaiters.get(url)
					if (cur) {
						cur.delete(notify)
						if (cur.size === 0) pendingWaiters.delete(url)
					}
					resolve()
				}, PENDING_TIMEOUT_MS)
			})
			res = await handleDifileRequest(ctx, { url, headers })
		}
		return res
	}

	// Install the difile:// protocol handler on a session. Idempotent per
	// session: a stale handler from a prior setup (e.g. fast app re-init in
	// tests) is replaced rather than throwing. Trusts that session's senders for
	// the temp-file / fs IPC channels.
	const installedSessions = new Set<Session>()
	function installOnSession(sess: Session): void {
		trustedSessions.add(sess)
		if (installedSessions.has(sess)) return
		installedSessions.add(sess)
		try {
			sess.protocol.unhandle('difile')
		} catch {
			// Not previously registered — fine.
		}
		sess.protocol.handle('difile', difileHandler)
	}

	installOnSession(simSession)
	// Apply to every per-project miniapp partition session (current + future).
	const unregisterConfigurator = registerMiniappSessionConfigurator((sess) => installOnSession(sess))

	// Phase 1 (P1-7): renderer FSM → main fs operations bridge. The same
	// simulator-only sender policy applies — registry instance is shared.
	registry.handle('simulator:fs:read', (_event, payload) =>
		handleFsRead(payload as Parameters<typeof handleFsRead>[0]),
	)
	registry.handle('simulator:fs:write', (_event, payload) =>
		handleFsWrite(payload as Parameters<typeof handleFsWrite>[0]),
	)
	registry.handle('simulator:fs:stat', (_event, payload) =>
		handleFsStat(payload as Parameters<typeof handleFsStat>[0]),
	)
	registry.handle('simulator:fs:readdir', (_event, payload) =>
		handleFsReaddir(payload as Parameters<typeof handleFsReaddir>[0]),
	)
	registry.handle('simulator:fs:unlink', (_event, payload) =>
		handleFsUnlink(payload as Parameters<typeof handleFsUnlink>[0]),
	)
	registry.handle('simulator:fs:mkdir', (_event, payload) =>
		handleFsMkdir(payload as Parameters<typeof handleFsMkdir>[0]),
	)

	return toDisposable(async () => {
		disposed = true
		unregisterConfigurator()
		drainAllWaiters()
		store.clear()
		for (const sess of installedSessions) {
			try {
				sess.protocol.unhandle('difile')
			} catch {
				// May already have been unhandled by app shutdown.
			}
		}
		await registry.dispose()
	})
}
