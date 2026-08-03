function snapshotStack() {
  try {
    if (typeof getCurrentPages !== 'function') return []
    var pages = getCurrentPages() || []
    var out = []
    for (var i = 0; i < pages.length; i++) {
      var p = pages[i] || {}
      out.push({
        route: p.route || p.__route__ || p.path || '',
        options: p.options || p.query || {},
      })
    }
    return out
  } catch (_) { return [] }
}

function record(page, hook, extra) {
  try {
    var raw = wx.getStorageSync('__pageStackLog')
    var arr = []
    if (Array.isArray(raw)) {
      arr = raw
    } else if (typeof raw === 'string' && raw) {
      try { arr = JSON.parse(raw) } catch (_) { arr = [] }
      if (!Array.isArray(arr)) arr = []
    }
    arr.push(Object.assign(
      { page: page, hook: hook, ts: Date.now(), stack: snapshotStack() },
      extra || {},
    ))
    wx.setStorageSync('__pageStackLog', JSON.stringify(arr))
  } catch (e) {}
}

Page({
  onLoad: function (options) {
    record('c', 'onLoad', { options: options || {} })
  },
  onShow: function () { record('c', 'onShow') },
  onHide: function () { record('c', 'onHide') },
  onUnload: function () { record('c', 'onUnload') }
})
