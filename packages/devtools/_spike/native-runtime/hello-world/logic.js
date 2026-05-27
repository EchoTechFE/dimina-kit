modDefine('app', (require, module, exports) => {
  App({
    onLaunch() {
      console.log('[app] launch')
    },
  })
})

modDefine('pages/index/index', (require, module, exports) => {
  globalThis.__extraInfo = {
    path: 'pages/index/index',
    component: false,
    usingComponents: {},
  }

  Page({
    data: { msg: 'hello world', count: 0 },
    onLoad() {
      console.log('[index] onLoad')
    },
    handleTap() {
      console.log('[index] handleTap')
      this.setData({ count: this.data.count + 1 })
    },
  })
})
