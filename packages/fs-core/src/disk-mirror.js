/**
 * 本地磁盘镜像（P5，Chromium only）—— showDirectoryPicker() 授权一个真实磁盘目录，
 * 把项目树 write-through 镜像过去：用户在访达/资源管理器里能看到自己的项目。
 * 这是"持久化到磁盘"的字面回答（架构文档 §4 出口 1）。
 *
 * 策略：fs-change 防抖 2s 全量比对同步（内容不变的文件跳过 —— 内容比对在内存，
 * 磁盘只写变更）；删除按上次镜像记录清理。授权需要用户手势，无授权时静默不动。
 */
export function createDiskMirror(fs) {
  let dir = null
  let last = new Map() // path -> content（上次已镜像的内容）
  let timer = null
  let syncing = false

  async function pick() {
    if (!window.showDirectoryPicker) throw new Error('showDirectoryPicker 不可用（需要 Chromium）')
    dir = await window.showDirectoryPicker({ mode: 'readwrite' })
    last = new Map()
    const r = await syncAll()
    return { name: dir.name, ...r }
  }

  async function syncAll() {
    if (!dir || syncing) return null
    syncing = true
    try {
      const snap = await fs.snapshot()
      let written = 0
      for (const [p, content] of Object.entries(snap.files)) {
        if (last.get(p) === content) continue
        const parts = p.split('/')
        let d = dir
        for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg, { create: true })
        const fh = await d.getFileHandle(parts[parts.length - 1], { create: true })
        const w = await fh.createWritable()
        await w.write(content)
        await w.close()
        last.set(p, content)
        written++
      }
      let removed = 0
      for (const p of [...last.keys()]) {
        if (p in snap.files) continue
        try {
          const parts = p.split('/')
          let d = dir
          for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg)
          await d.removeEntry(parts[parts.length - 1])
        } catch { /* 目录已不在等：忽略 */ }
        last.delete(p)
        removed++
      }
      return { written, removed, gen: snap.gen }
    } finally {
      syncing = false
    }
  }

  function schedule() {
    if (!dir) return
    clearTimeout(timer)
    timer = setTimeout(() => { syncAll().catch(() => {}) }, 2000)
  }

  return { pick, syncAll, schedule, get active() { return !!dir } }
}
