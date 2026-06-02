Page({
  // Declared default data — added for native-host-navigate-data.spec.ts.
  // Lets the e2e assert that navigateTo'd (non-root) pages get a mounted
  // service instance with its initial data in ctx.appData (Bug-3 regression).
  data: {
    probeName: 'detail-probe',
    count: 42,
  },
  goBack() {
    wx.navigateBack()
  }
})
