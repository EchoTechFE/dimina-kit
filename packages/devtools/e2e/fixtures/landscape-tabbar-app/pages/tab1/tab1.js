// Tab page with the DEFAULT navigation bar.
// No `pageOrientation` of its own, so it resolves through the fallback chain to app.json's `window.pageOrientation` ("auto") and therefore follows the simulated device's own orientation.
//
// The geometry probes below render straight into the DOM so the e2e reads the numbers the mini-app actually sees, not a console line.
let activePage = null

function windowResizeListener(res) {
  if (!activePage) return
  activePage.setData({
    winResizeCount: (activePage.data.winResizeCount || 0) + 1,
    winResizeText: JSON.stringify(res),
  })
}

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
    winResizeCount: 0,
    winResizeText: '',
    tabBarToggleText: '',
  },
  onLoad() {
    activePage = this
    if (typeof wx.onWindowResize === 'function') wx.onWindowResize(windowResizeListener)
    this.publishGeometry()
  },
  onShow() {
    activePage = this
    this.publishGeometry()
  },
  onUnload() {
    if (typeof wx.offWindowResize === 'function') wx.offWindowResize(windowResizeListener)
    if (activePage === this) activePage = null
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
  // The window height is read INSIDE the success callback: hiding the bar hands its height to the page viewport, and a mini-app is entitled to see that the moment the call it made reports success.
  hideTabBar() {
    const self = this
    wx.hideTabBar({
      success() {
        self.setData({
          tabBarToggleText: JSON.stringify({ call: 'hideTabBar', windowHeight: wx.getWindowInfo().windowHeight }),
        })
      },
    })
  },
  showTabBar() {
    const self = this
    wx.showTabBar({
      success() {
        self.setData({
          tabBarToggleText: JSON.stringify({ call: 'showTabBar', windowHeight: wx.getWindowInfo().windowHeight }),
        })
      },
    })
  },
  goDetail() {
    wx.navigateTo({ url: '/pages/detail/detail' })
  },
  goPortrait() {
    wx.navigateTo({ url: '/pages/portrait/portrait' })
  },
})
