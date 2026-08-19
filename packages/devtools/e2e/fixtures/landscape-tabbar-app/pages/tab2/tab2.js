// Tab page with `navigationStyle: "custom"`: no navigation bar and no status bar reserved above it, so the page is full-bleed from the very top of the screen.
// Orientation still comes from app.json's `window.pageOrientation` ("auto"), so it follows the simulated device like tab1 does.
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
})
