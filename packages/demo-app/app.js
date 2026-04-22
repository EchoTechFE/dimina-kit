App({
  onLaunch() {
    console.log('[Demo] App launched')
    console.log('[Demo] globalData:', this.globalData)
  },
  onShow() {
    console.log('[Demo] App onShow')
  },
  onHide() {
    console.log('[Demo] App onHide')
  },
  onError(err) {
    console.error('[Demo] App onError:', err)
  },
  globalData: {
    appName: 'DevTools Demo',
    version: '1.0.0',
    launchTime: Date.now()
  }
})
