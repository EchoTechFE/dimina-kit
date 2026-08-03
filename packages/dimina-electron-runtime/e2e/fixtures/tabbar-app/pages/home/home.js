Page({
  data: {
    pageName: 'home',
    counter: 7,
    profile: { nick: 'tester' },
  },
  goDetail() {
    wx.navigateTo({ url: '/pages/detail/detail' })
  }
})
