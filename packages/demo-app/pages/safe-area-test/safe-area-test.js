// 用 CSS env(safe-area-inset-*) 撑出四个探针元素，再量它们的实际尺寸，
// 和 wx 侧 safeArea 数值放在一起对照。切换机型、横竖屏后会自动重量。
const SIDES = ['top', 'right', 'bottom', 'left']

Page({
  data: {
    cssInsets: { top: '-', right: '-', bottom: '-', left: '-' },
    windowInfo: {},
    safeArea: {},
    orientation: '-'
  },

  onLoad() {
    console.log('[SafeArea] 页面加载')
  },

  onReady() {
    this.measure()
  },

  onResize(res) {
    console.log('[SafeArea] onResize:', res)
    this.measure()
  },

  measure() {
    this.readWindowInfo()
    const query = wx.createSelectorQuery()
    SIDES.forEach((side) => query.select(`#probe-${side}`).boundingClientRect())
    query.exec((rects) => {
      const cssInsets = {}
      SIDES.forEach((side, i) => {
        const rect = rects[i]
        if (!rect) {
          cssInsets[side] = 'n/a'
          return
        }
        // 上下探针量高度，左右探针量宽度
        const size = side === 'top' || side === 'bottom' ? rect.height : rect.width
        cssInsets[side] = `${Math.round(size * 100) / 100}px`
      })
      console.log('[SafeArea] env(safe-area-inset-*) 实测:', cssInsets)
      this.setData({ cssInsets })
    })
  },

  readWindowInfo() {
    try {
      const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync()
      const safeArea = info.safeArea || {}
      this.setData({
        windowInfo: {
          screenWidth: info.screenWidth,
          screenHeight: info.screenHeight,
          windowWidth: info.windowWidth,
          windowHeight: info.windowHeight,
          statusBarHeight: info.statusBarHeight
        },
        safeArea: {
          top: safeArea.top,
          right: safeArea.right,
          bottom: safeArea.bottom,
          left: safeArea.left,
          width: safeArea.width,
          height: safeArea.height
        },
        orientation: info.deviceOrientation || '-'
      })
      console.log('[SafeArea] windowInfo:', info)
    } catch (e) {
      console.error('[SafeArea] 读取窗口信息失败:', e)
    }
  },

  remeasure() {
    this.measure()
    wx.showToast({ title: '已重新测量', icon: 'none', duration: 800 })
  }
})
