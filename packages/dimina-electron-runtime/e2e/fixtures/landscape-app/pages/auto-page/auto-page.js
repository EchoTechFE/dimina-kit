// pageOrientation: 'auto' — follows the simulated device's own orientation. resizeCount/lastResize record every Page.onResize call so the e2e can assert it fires exactly once per rotation, with the payload shape { size: { windowWidth, windowHeight }, deviceOrientation }.
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
