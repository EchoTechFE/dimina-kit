Page({
  onShow() {
    console.log('[TabBarMe] onShow')
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' })
  },

  setHomeBadge() {
    wx.setTabBarBadge({ index: 0, text: 'NEW' })
  },

  clearHomeBadge() {
    wx.removeTabBarBadge({ index: 0 })
  },

  setTitle() {
    wx.setTabBarItem({ index: 0, text: '主页' })
  },

  resetTitle() {
    wx.setTabBarItem({ index: 0, text: '首页' })
  },

  hideBar() {
    wx.hideTabBar({ animation: true })
  },

  showBar() {
    wx.showTabBar({ animation: true })
  }
})
