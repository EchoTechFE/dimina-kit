/**
 * fs-query worker — ProjectFS 只读镜像。
 * fs-core 经专用 MessagePort 推 {gen, diff|full}；本 worker 承接 snapshot/grep/glob/大读，
 * 查询永不进入写路径（fs-core 的事件循环不被大 grep 阻塞）。镜像无持久状态，可随时重建。
 */
const state = {
  mirror: new Map(), // path -> {content, rev}
  gen: -1,           // -1 = 尚未收到 core 的首次同步
  waiters: [],       // [{gen, resolve, timer}]
}

function applySync(msg) {
  if (msg.full) {
    state.mirror.clear()
    for (const [p, ent] of Object.entries(msg.files)) state.mirror.set(p, ent)
  } else {
    for (const [p, ent] of Object.entries(msg.diff)) {
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
function whenGen(gen) {
  if (gen === undefined || state.gen >= gen) return Promise.resolve()
  return new Promise((resolve) => {
    const w = { gen, resolve, timer: setTimeout(() => { state.waiters = state.waiters.filter((x) => x !== w); resolve() }, 5000) }
    state.waiters.push(w)
  })
}

function globToRegExp(pattern) {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') { re += pattern[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += pattern[i + 2] === '/' ? 2 : 1 }
      else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += /[.+^${}()|[\]\\]/.test(c) ? '\\' + c : c
  }
  return new RegExp('^' + re + '$')
}

const ops = {
  async snapshot({ gen }) {
    await whenGen(gen)
    const files = {}
    for (const [p, ent] of state.mirror) files[p] = ent.content
    return { files, gen: state.gen, stale: gen !== undefined && state.gen < gen }
  },
  async read({ path, gen }) {
    await whenGen(gen)
    const e = state.mirror.get(path)
    if (!e) throw Object.assign(new Error(path), { code: 'not-found' })
    return { content: e.content, rev: e.rev, gen: state.gen }
  },
  async glob({ pattern, gen }) {
    await whenGen(gen)
    const re = globToRegExp(pattern)
    return { paths: [...state.mirror.keys()].filter((p) => re.test(p)).sort(), gen: state.gen }
  },
  async grep({ pattern, flags = '', glob, gen, limit = 200 }) {
    await whenGen(gen)
    const re = new RegExp(pattern, flags.replace('g', ''))
    const scope = glob ? globToRegExp(glob) : null
    const hits = []
    for (const [path, ent] of state.mirror) {
      if (scope && !scope.test(path)) continue
      const lines = ent.content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push({ path, lineNo: i + 1, line: lines[i].slice(0, 500) })
          if (hits.length >= limit) return { hits, gen: state.gen, truncated: true }
        }
      }
    }
    return { hits, gen: state.gen, truncated: false }
  },
}

self.onmessage = async (e) => {
  const msg = e.data
  if (msg.type === 'init') {
    msg.corePort.onmessage = (ev) => applySync(ev.data)
    self.postMessage({ type: 'ready' })
    return
  }
  if (msg.id === undefined) return
  try {
    const result = await ops[msg.op](msg.args || {})
    self.postMessage({ id: msg.id, ok: true, result })
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, code: err.code || 'internal', error: err.message || String(err) })
  }
}
