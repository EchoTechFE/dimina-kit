// pageOrientation: 'auto' overrides the app-level 'landscape' and follows the simulated device's own orientation instead. resizeCount/lastResize record every Page.onResize call for the e2e to assert on.
Page({
  data: {
    resizeCount: 0,
    lastResize: null,
  },
  onResize(res) {
    this.setData({
      resizeCount: this.data.resizeCount + 1,
      lastResize: res,
    })
  },
})
