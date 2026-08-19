// No page-level pageOrientation — resolves to app.json's window.pageOrientation ('landscape'), a FIXED orientation. resizeCount/lastResize record every Page.onResize call so the e2e can assert the fixed-orientation gate holds for a page that inherited its orientation rather than declaring it.
//
// onLoadWindowWidth/onLoadWindowHeight capture a SYNCHRONOUS wx.getSystemInfoSync() call made from onLoad itself — the earliest a page's own code can observe its geometry, before any PAGE_RESIZE from DeviceShell could have corrected a wrong cold-start seed. onLaunchWindowWidth/onLaunchWindowHeight fold in App.onLaunch's own (even earlier) synchronous reading via globalData, so both observation points the cold-start seed exists for are asserted on, not just one.
Page({
  data: {
    resizeCount: 0,
    lastResize: null,
    onLoadWindowWidth: null,
    onLoadWindowHeight: null,
    onLaunchWindowWidth: null,
    onLaunchWindowHeight: null,
  },
  onLoad() {
    const info = wx.getSystemInfoSync()
    const app = getApp()
    this.setData({
      onLoadWindowWidth: info.windowWidth,
      onLoadWindowHeight: info.windowHeight,
      onLaunchWindowWidth: app.globalData.onLaunchWindowWidth,
      onLaunchWindowHeight: app.globalData.onLaunchWindowHeight,
    })
  },
  onResize(res) {
    this.setData({
      resizeCount: this.data.resizeCount + 1,
      lastResize: res,
    })
  },
})
