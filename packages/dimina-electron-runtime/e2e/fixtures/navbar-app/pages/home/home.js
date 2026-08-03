Page({
  setTitle() {
    wx.setNavigationBarTitle({ title: 'Renamed' })
  },
  setColor() {
    wx.setNavigationBarColor({ frontColor: '#000000', backgroundColor: '#ffffff' })
  },
  showLoading() {
    wx.showNavigationBarLoading()
  },
  hideLoading() {
    wx.hideNavigationBarLoading()
  },
  goDetail() {
    wx.navigateTo({ url: '/pages/detail/detail' })
  },
  goBlack() {
    wx.navigateTo({ url: '/pages/black-title/black-title' })
  },
  goCustom() {
    wx.navigateTo({ url: '/pages/custom-style/custom-style' })
  }
})
