// Lifecycle recorder for e2e page-stack tests. Each hook appends an event to
// the wx.storage key `__pageStackLog` so tests can replay the order.
//
// NOTE: wx.getStorageSync auto-parses JSON, so the stored array comes back as
// an array (not a string). We accept both forms defensively in case the impl
// behaviour changes.
// Snapshot getCurrentPages() into a {route, options}[] form so the test can
// inspect stack state at the time of each lifecycle event.
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
  } catch (e) {
    // swallow — recorder must never break the page
  }
}

Page({
  onLoad: function (options) {
    record('home', 'onLoad', { options: options || {} })
  },
  onShow: function () {
    record('home', 'onShow')
  },
  onHide: function () {
    record('home', 'onHide')
  },
  onUnload: function () {
    record('home', 'onUnload')
  },
  goA: function () { wx.navigateTo({ url: '/pages/a/a' }) },
  goB: function () { wx.navigateTo({ url: '/pages/b/b' }) },
  goC: function () { wx.navigateTo({ url: '/pages/c/c' }) },
  goExplore: function () { wx.switchTab({ url: '/pages/explore/explore' }) }
})
