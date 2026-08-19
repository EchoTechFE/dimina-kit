// pageOrientation: 'portrait' overrides the app-level 'landscape', a FIXED orientation independent of both the app default and the device. resizeCount/lastResize record every Page.onResize call for the e2e to assert on.
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
