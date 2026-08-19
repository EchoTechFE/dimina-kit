// No page-level pageOrientation — resolves to app.json's window.pageOrientation ('landscape'), a FIXED orientation.
// Used as a middle page of a three-deep stack so route tests can assert each layer resolves its own orientation independent of its neighbors. resizeCount/lastResize record every Page.onResize call for the e2e to assert on.
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
