// Non-tab page reached by `wx.navigateTo`, pinned to `pageOrientation: "landscape"` — a page-level value that overrides app.json's "auto".
// Entering it turns the simulator landscape even on a portrait device; leaving it restores whatever orientation was on screen before.
function readGeometry() {
  const sys = wx.getSystemInfoSync()
  const win = wx.getWindowInfo()
  return {
    systemInfo: {
      screenWidth: sys.screenWidth,
      screenHeight: sys.screenHeight,
      windowWidth: sys.windowWidth,
      windowHeight: sys.windowHeight,
      statusBarHeight: sys.statusBarHeight,
      deviceOrientation: sys.deviceOrientation,
      safeArea: sys.safeArea,
    },
    windowInfo: {
      screenWidth: win.screenWidth,
      screenHeight: win.screenHeight,
      windowWidth: win.windowWidth,
      windowHeight: win.windowHeight,
      statusBarHeight: win.statusBarHeight,
      safeArea: win.safeArea,
    },
  }
}

Page({
  data: {
    geometryText: '',
    resizeCount: 0,
    resizeText: '',
  },
  onLoad() {
    this.publishGeometry()
  },
  onShow() {
    this.publishGeometry()
  },
  onResize(res) {
    this.setData({
      resizeCount: this.data.resizeCount + 1,
      resizeText: JSON.stringify(res),
    })
    this.publishGeometry()
  },
  publishGeometry() {
    this.setData({ geometryText: JSON.stringify(readGeometry()) })
  },
  goBack() {
    wx.navigateBack()
  },
})
