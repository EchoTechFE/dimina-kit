Page({
  data: {
    statusBarHeight: 0,
    navHeight: 0
  },

  onLoad() {
    console.log('[Fullscreen] 页面加载 - navigationStyle: custom')
    try {
      const info = wx.getSystemInfoSync()
      const statusBarHeight = info.statusBarHeight || 20
      const navHeight = statusBarHeight + 44
      this.setData({ statusBarHeight, navHeight })
      console.log('[Fullscreen] 状态栏高度:', statusBarHeight, '导航栏总高度:', navHeight)
    } catch (e) {
      console.error('[Fullscreen] 获取系统信息失败:', e)
      this.setData({ statusBarHeight: 20, navHeight: 64 })
    }
  },

  goBack() {
    wx.navigateBack()
  }
})
