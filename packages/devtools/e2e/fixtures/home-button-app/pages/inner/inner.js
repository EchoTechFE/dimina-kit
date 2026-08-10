Page({
  data: {
    pageName: 'inner',
  },
  goForced() {
    wx.navigateTo({ url: '/pages/forced/forced' })
  },
})
