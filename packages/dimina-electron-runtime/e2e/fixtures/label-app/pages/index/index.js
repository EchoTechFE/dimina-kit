// 每个绑定把 `${data-name}.${事件类型}` 计数写进 page data，
// e2e 读 page data 判断一次真实点击在各节点上产生了几次事件。
Page({
  data: {
    counts: {},
    switchA: false,
    switchB: false,
  },

  bump(key) {
    const counts = Object.assign({}, this.data.counts)
    counts[key] = (counts[key] || 0) + 1
    this.setData({ counts })
  },

  hitName(e) {
    return e.currentTarget.dataset.name
  },

  onTap(e) {
    this.bump(this.hitName(e) + '.tap')
  },

  onChange(e) {
    const name = this.hitName(e)
    this.bump(name + '.change')
    if (name === 'switchA') this.setData({ switchA: e.detail.value })
    if (name === 'switchB') this.setData({ switchB: e.detail.value })
  },

  onFocus(e) {
    this.bump(this.hitName(e) + '.focus')
  },
})
