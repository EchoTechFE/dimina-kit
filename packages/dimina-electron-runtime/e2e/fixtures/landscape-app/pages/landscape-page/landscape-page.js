// pageOrientation: 'landscape' — a FIXED-orientation page.
// A page whose computed orientation isn't 'auto' and has never called A fixed-orientation page must never receive Page.onResize, no matter how the simulated device rotates under it. resizeCount/lastResize record every onResize call so the e2e can assert that gate holds (or catch it firing).
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
