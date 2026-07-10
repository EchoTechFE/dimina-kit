/**
 * fs-query worker — ProjectFS 只读镜像。
 * fs-core 经专用 MessagePort 推 {gen, diff|full}；本 worker 承接 snapshot/grep/glob/大读，
 * 查询永不进入写路径（fs-core 的事件循环不被大 grep 阻塞）。镜像无持久状态，可随时重建。
 */

interface MirrorEntry {
  content: string
  rev?: number
}

interface QueryOpError extends Error {
  code?: string
}

interface SyncMsg {
  gen: number
  full?: boolean
  files?: Record<string, MirrorEntry>
  diff?: Record<string, MirrorEntry | null>
}

interface Waiter {
  gen: number
  resolve: () => void
  timer: ReturnType<typeof setTimeout>
}

const state: {
  mirror: Map<string, MirrorEntry>
  gen: number
  waiters: Waiter[]
} = {
  mirror: new Map(), // path -> {content, rev}
  gen: -1,           // -1 = 尚未收到 core 的首次同步
  waiters: [],       // [{gen, resolve, timer}]
}

function applySync(msg: SyncMsg): void {
  if (msg.full) {
    state.mirror.clear()
    for (const [p, ent] of Object.entries(msg.files || {})) state.mirror.set(p, ent)
  } else {
    for (const [p, ent] of Object.entries(msg.diff || {})) {
      if (ent === null) state.mirror.delete(p)
      else state.mirror.set(p, ent)
    }
  }
  state.gen = msg.gen
  state.waiters = state.waiters.filter((w) => {
    if (state.gen >= w.gen) { clearTimeout(w.timer); w.resolve(); return false }
    return true
  })
}

/** 等镜像追平 gen；超时则按当前 gen 返回（结果带 stale 标记）。 */
function whenGen(gen: number | undefined): Promise<void> {
  if (gen === undefined || state.gen >= gen) return Promise.resolve()
  return new Promise((resolve) => {
    const w: Waiter = { gen, resolve, timer: setTimeout(() => { state.waiters = state.waiters.filter((x) => x !== w); resolve() }, 5000) }
    state.waiters.push(w)
  })
}

const GLOB_SPECIAL_RE = /[.+^${}()|[\]\\]/

/** Translates the glob token starting at `pattern[i]`; returns the regex
 * fragment plus how many EXTRA characters (beyond the one at `i`) it consumed,
 * so the caller's loop index can skip over a consumed double-star (with or
 * without a trailing slash). */
function translateGlobToken(pattern: string, i: number): { token: string; skip: number } {
  const c = pattern[i]
  if (c === '*') {
    if (pattern[i + 1] === '*') {
      const slash = pattern[i + 2] === '/'
      return { token: slash ? '(?:.*/)?' : '.*', skip: slash ? 2 : 1 }
    }
    return { token: '[^/]*', skip: 0 }
  }
  if (c === '?') return { token: '[^/]', skip: 0 }
  const escaped = GLOB_SPECIAL_RE.test(c!) ? '\\' + c : c!
  return { token: escaped, skip: 0 }
}

function globToRegExp(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const { token, skip } = translateGlobToken(pattern, i)
    re += token
    i += skip
  }
  return new RegExp('^' + re + '$')
}

const ops = {
  async snapshot({ gen }: { gen?: number }) {
    await whenGen(gen)
    const files: Record<string, string> = {}
    for (const [p, ent] of state.mirror) files[p] = ent.content
    return { files, gen: state.gen, stale: gen !== undefined && state.gen < gen }
  },
  async read({ path, gen }: { path: string; gen?: number }) {
    await whenGen(gen)
    const e = state.mirror.get(path)
    if (!e) throw Object.assign(new Error(path), { code: 'not-found' })
    return { content: e.content, rev: e.rev, gen: state.gen }
  },
  async glob({ pattern, gen }: { pattern: string; gen?: number }) {
    await whenGen(gen)
    const re = globToRegExp(pattern)
    return { paths: [...state.mirror.keys()].filter((p) => re.test(p)).sort(), gen: state.gen }
  },
  async grep({ pattern, flags = '', glob, gen, limit = 200 }: { pattern: string; flags?: string; glob?: string; gen?: number; limit?: number }) {
    await whenGen(gen)
    const re = new RegExp(pattern, flags.replace('g', ''))
    const scope = glob ? globToRegExp(glob) : null
    const hits: Array<{ path: string; lineNo: number; line: string }> = []
    for (const [path, ent] of state.mirror) {
      if (scope && !scope.test(path)) continue
      const lines = ent.content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          hits.push({ path, lineNo: i + 1, line: lines[i]!.slice(0, 500) })
          if (hits.length >= limit) return { hits, gen: state.gen, truncated: true }
        }
      }
    }
    return { hits, gen: state.gen, truncated: false }
  },
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data
  if (msg.type === 'init') {
    msg.corePort.onmessage = (ev: MessageEvent) => applySync(ev.data)
    self.postMessage({ type: 'ready' })
    return
  }
  if (msg.id === undefined) return
  try {
    // ops's members are declared via method shorthand with their own distinct
    // arg shapes; dispatching by dynamic string key needs one widening cast —
    // through `unknown` since the concrete shapes don't structurally overlap
    // with a single dynamic-args signature.
    const dispatch = ops as unknown as Record<string, (args: Record<string, unknown>) => Promise<unknown>>
    const result = await dispatch[msg.op]!(msg.args || {})
    self.postMessage({ id: msg.id, ok: true, result })
  } catch (err) {
    const e = err as QueryOpError
    self.postMessage({ id: msg.id, ok: false, code: e.code || 'internal', error: e.message || String(err) })
  }
}
