// Default (unconfigured) page — pageOrientation falls back to app.json's window (unset here too), so this page is fixed portrait.
Page({
  goLandscape() {
    wx.navigateTo({ url: '/pages/landscape-page/landscape-page' })
  },
  goAuto() {
    wx.navigateTo({ url: '/pages/auto-page/auto-page' })
  },
})
