/**
 * Phase 0 vpath resolver.
 *
 * Spec: `docs/file-system.md` §3.3 — single resolver shared by every FSM
 * entry, the renderer-side temp store, and (Phase 1) the main-process
 * protocol.handle / disk reader.
 *
 *   resolveVPath(url): { kind, writable, realPath? } | null
 *
 *   - `difile://_tmp/<id>`   → kind=tmp,   writable=false, no realPath
 *   - `difile://_store/<id>` → kind=store, writable=false, realPath in base
 *   - `difile://<rel>`       → kind=usr,   writable=true,  realPath in base
 *
 * Security invariants (the resolver returns `null` instead of throwing):
 *   - any non-`difile://` scheme is rejected outright;
 *   - any `..` segment (raw or URL-encoded) is rejected before canonicalize;
 *   - after `path.normalize` the resulting `realPath` MUST stay inside the
 *     sandbox base; otherwise `null`;
 *   - reserved prefixes `_tmp/` and `_store/` are case-sensitive — `_TMP/`,
 *     `_Tmp/`, etc. fall through to the user-data namespace.
 */

// Main-process (Node ESM) resolves these natively. Simulator (vite browser
// bundle) externalizes node builtins as no-op stubs — that's safe here only
// because the simulator never enters the `store`/`usr` branches below
// (renderer-side FSM forwards disk-backed reads/writes to main via IPC).
import os from 'node:os'
import path from 'node:path'

export type VPathKind = 'tmp' | 'store' | 'usr'

export interface ResolvedVPath {
	kind: VPathKind
	/** `tmp` and `store` are runtime-owned and read-only; `usr` is writable. */
	writable: boolean
	/**
	 * Canonical local path on disk for `store` / `usr` kinds (always within the
	 * USER_DATA_PATH base directory after canonicalize). `tmp` kind has no
	 * realPath — the bytes live in the renderer-side Blob Map.
	 */
	realPath?: string
}

const DIFILE_PREFIX = 'difile://'

/**
 * USER_DATA_PATH sandbox base. Looked up dynamically on every call so test
 * doubles (e.g. monkey-patching `os.homedir`) and the `DIMINA_HOME` env
 * override apply per invocation. The env override exists for headless test
 * affordance and to keep the renderer/main store sharing one base.
 */
export function sandboxBase(): string {
	const env = (typeof process !== 'undefined' && process.env && process.env.DIMINA_HOME) || ''
	if (env) {
		return path.join(env, 'files')
	}
	return path.join(os.homedir(), '.dimina', 'files')
}

export function resolveVPath(url: unknown): ResolvedVPath | null {
	if (typeof url !== 'string') return null
	if (!url.startsWith(DIFILE_PREFIX)) return null

	const raw = url.slice(DIFILE_PREFIX.length)
	if (raw.length === 0) return null

	// Decode URL-encoded sequences first so `%2e%2e` style escapes are caught
	// by the segment check below.
	let decoded: string
	try {
		decoded = decodeURIComponent(raw)
	} catch {
		return null
	}

	// Reject NUL bytes (raw or %00) — Node `fs.*` throws TypeError on a NUL
	// in the path, bypassing the API's `fail` callback and crashing the
	// renderer. Pull the rejection up to the validator.
	if (decoded.includes('\0')) return null

	// Developer convention: `wx.env.USER_DATA_PATH = 'difile://'` so a write
	// like `${USER_DATA_PATH}/foo.txt` produces `difile:///foo.txt`. Strip
	// leading slashes so that path-joins cleanly under the sandbox base.
	decoded = decoded.replace(/^[/\\]+/, '')
	if (decoded.length === 0) return null

	// Reject any '..' or '.' segment after decoding. We split on both '/' and
	// '\\' so Windows-style separators cannot smuggle a traversal segment past
	// the validator on POSIX hosts.
	const segments = decoded.split(/[/\\]+/)
	if (segments.some(s => s === '..' || s === '.')) return null

	// Classify by reserved prefix (case-sensitive — `_TMP/` is a user file).
	let kind: VPathKind
	let writable: boolean
	if (decoded.startsWith('_tmp/')) {
		kind = 'tmp'
		writable = false
	} else if (decoded.startsWith('_store/')) {
		kind = 'store'
		writable = false
	} else {
		kind = 'usr'
		writable = true
	}

	// `tmp` lives in the renderer Blob Map — no realPath.
	if (kind === 'tmp') {
		return { kind, writable }
	}

	// `store` / `usr`: anchor under the sandbox base and assert containment
	// after normalization. Defense in depth against any traversal that the
	// segment check above missed (e.g. backslash trickery on POSIX).
	const base = sandboxBase()
	const joined = path.join(base, decoded)
	const normalized = path.normalize(joined)
	if (normalized !== base && !normalized.startsWith(base + path.sep)) return null

	return { kind, writable, realPath: normalized }
}
