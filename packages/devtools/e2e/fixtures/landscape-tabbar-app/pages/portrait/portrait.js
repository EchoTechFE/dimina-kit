// Non-tab page pinned to `pageOrientation: "portrait"`.
// Entering it from a landscape device proves a mini-app's forced orientation only changes what is drawn — the simulated device's own orientation is never written back, so it is still landscape after the project closes.
function readGeometry() {
  const sys = wx.getSystemInfoSync()
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
  }
}

Page({
  data: {
    geometryText: '',
  },
  onLoad() {
    this.setData({ geometryText: JSON.stringify(readGeometry()) })
  },
  onShow() {
    this.setData({ geometryText: JSON.stringify(readGeometry()) })
  },
})
