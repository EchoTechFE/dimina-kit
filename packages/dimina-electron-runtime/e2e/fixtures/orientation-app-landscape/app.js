// App.onLaunch runs before any page's onLoad — a synchronous wx.getSystemInfoSync() call here is the EARLIEST point the cold-start orientation seed (bridge-router.ts's resolvePageWindowConfig / resolvePageOrientationState) can be observed, before DeviceShell has even mounted to send its first PAGE_RESIZE. globalData carries the snapshot so the root page can fold it into its own page data for the e2e to read back through getPageData.
App({
  globalData: {},
  onLaunch() {
    const info = wx.getSystemInfoSync()
    this.globalData.onLaunchWindowWidth = info.windowWidth
    this.globalData.onLaunchWindowHeight = info.windowHeight
  },
})

