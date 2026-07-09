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
  let pending = false // syncAll 运行期间又发生了变更，结束后需要再镜像一轮

  /** @param {FileSystemDirectoryHandle} [handle] 已获取授权的目录句柄；传了就直接用（跳过
   * showDirectoryPicker 弹窗），调用方自行负责获取授权（例如复用宿主已有的句柄）。 */
  async function pick(handle) {
    if (handle) {
      dir = handle
    } else {
      if (!window.showDirectoryPicker) throw new Error('showDirectoryPicker 不可用（需要 Chromium）')
      dir = await window.showDirectoryPicker({ mode: 'readwrite' })
    }
    last = new Map()
    const r = await syncAll()
    return { name: dir.name, ...r }
  }

  /** 停用镜像：取消挂起的防抖定时器，清空目录句柄与镜像记账，使后续任何 syncAll
   * 调用（包括仍在飞行中的定时器回调）在入口处天然短路。 */
  function dispose() {
    clearTimeout(timer)
    dir = null
    last = new Map()
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
      if (pending && dir) {
        pending = false
        schedule()
      }
    }
  }

  function schedule() {
    if (!dir) return
    if (syncing) {
      // 一轮 syncAll 正在进行中：这次变更不能被这轮同步捕获（快照已在读取途中），
      // 也不能立刻并发再跑一轮（syncAll 自身会在入口处丢弃）。记一个 pending，
      // 交给上面 syncAll 的 finally 在这轮结束后重新排期，保证不丢更新。
      pending = true
      return
    }
    clearTimeout(timer)
    timer = setTimeout(() => { syncAll().catch(() => {}) }, 2000)
  }

  return { pick, syncAll, schedule, dispose, get active() { return !!dir } }
}
