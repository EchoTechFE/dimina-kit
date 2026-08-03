// Minimal logic.js fixture for the native-host e2e suite.
// Uses globalThis.modDefine that dimina-service installs at boot so the
// container can locate App + Page factories on demand.
modDefine('app', (require, module, exports) => {
  App({
    onLaunch() {
      console.log('[fixture-app] launch')
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
    data: { title: 'Home' },
    onLoad(query) { console.log('[fixture-index] onLoad', JSON.stringify(query || {})) },
    onShow() { console.log('[fixture-index] onShow') },
    onHide() { console.log('[fixture-index] onHide') },
    onUnload() { console.log('[fixture-index] onUnload') },
  })
})

modDefine('pages/detail/detail', (require, module, exports) => {
  globalThis.__extraInfo = {
    path: 'pages/detail/detail',
    component: false,
    usingComponents: {},
  }
  Page({
    data: { title: 'Detail' },
    onLoad(query) { console.log('[fixture-detail] onLoad', JSON.stringify(query || {})) },
    onShow() { console.log('[fixture-detail] onShow') },
    onUnload() { console.log('[fixture-detail] onUnload') },
  })
})

modDefine('pages/cart/cart', (require, module, exports) => {
  globalThis.__extraInfo = {
    path: 'pages/cart/cart',
    component: false,
    usingComponents: {},
  }
  Page({
    data: { title: 'Cart' },
    onLoad() { console.log('[fixture-cart] onLoad') },
    onShow() { console.log('[fixture-cart] onShow') },
    onHide() { console.log('[fixture-cart] onHide') },
  })
})

modDefine('pages/me/me', (require, module, exports) => {
  globalThis.__extraInfo = {
    path: 'pages/me/me',
    component: false,
    usingComponents: {},
  }
  Page({
    data: { title: 'Me' },
    onLoad() { console.log('[fixture-me] onLoad') },
    onShow() { console.log('[fixture-me] onShow') },
    onHide() { console.log('[fixture-me] onHide') },
  })
})
