Page({
  data: {
    menuItems: [
      {
        path: '/pages/console-test/console-test',
        icon: '\u{1F4DD}',
        title: 'Console \u8F93\u51FA\u6D4B\u8BD5',
        subtitle: '\u6D4B\u8BD5 log/warn/error/info/debug \u53CA\u5F02\u5E38\u6355\u83B7',
        tags: ['console', 'onerror']
      },
      {
        path: '/pages/storage-test/storage-test',
        icon: '\u{1F4BE}',
        title: 'Storage \u5B58\u50A8\u6D4B\u8BD5',
        subtitle: '\u6D4B\u8BD5 localStorage \u7684\u589E\u5220\u6539\u67E5',
        tags: ['localStorage', 'setItem', 'getItem']
      },
      {
        path: '/pages/network-test/network-test',
        icon: '\u{1F310}',
        title: 'Network \u7F51\u7EDC\u6D4B\u8BD5',
        subtitle: '\u6D4B\u8BD5 GET/POST \u8BF7\u6C42\u3001\u8D85\u65F6\u3001\u9519\u8BEF\u54CD\u5E94',
        tags: ['GET', 'POST', 'timeout']
      },
      {
        path: '/pages/component-test/component-test',
        icon: '\u{1F9E9}',
        title: '\u7EC4\u4EF6 & AppData \u6D4B\u8BD5',
        subtitle: '\u6D4B\u8BD5\u7EC4\u4EF6\u72B6\u6001\u3001\u5D4C\u5957\u7EC4\u4EF6\u3001WXML \u6811',
        tags: ['setData', 'WXML', '\u7EC4\u4EF6']
      }
    ],
    deviceInfo: {}
  },

  onLoad() {
    console.log('[Index] \u9875\u9762\u52A0\u8F7D')
    this.loadDeviceInfo()
  },

  onShow() {
    console.log('[Index] \u9875\u9762\u663E\u793A')
  },

  loadDeviceInfo() {
    try {
      const info = wx.getSystemInfoSync()
      this.setData({
        deviceInfo: {
          screenWidth: info.screenWidth,
          screenHeight: info.screenHeight,
          windowWidth: info.windowWidth,
          windowHeight: info.windowHeight,
          pixelRatio: info.pixelRatio,
          platform: info.platform
        }
      })
      console.log('[Index] \u8BBE\u5907\u4FE1\u606F:', info)
    } catch (e) {
      console.error('[Index] \u83B7\u53D6\u8BBE\u5907\u4FE1\u606F\u5931\u8D25:', e)
      this.setData({
        deviceInfo: {
          screenWidth: '-',
          screenHeight: '-',
          windowWidth: '-',
          windowHeight: '-',
          pixelRatio: '-',
          platform: '-'
        }
      })
    }
  },

  navigateTo(e) {
    const path = e.currentTarget.dataset.path
    console.log('[Index] \u5BFC\u822A\u5230:', path)
    wx.navigateTo({ url: path })
  }
})
