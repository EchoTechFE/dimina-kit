Page({
  data: {
    menuItems: [
      {
        path: '/pages/console-test/console-test',
        icon: '\u{1F4DD}',
        title: 'Console 输出测试',
        subtitle: '测试 log/warn/error/info/debug 及异常捕获',
        tags: ['console', 'onerror']
      },
      {
        path: '/pages/storage-test/storage-test',
        icon: '\u{1F4BE}',
        title: 'Storage 存储测试',
        subtitle: '测试 localStorage 的增删改查',
        tags: ['localStorage', 'setItem', 'getItem']
      },
      {
        path: '/pages/network-test/network-test',
        icon: '\u{1F310}',
        title: 'Network 网络测试',
        subtitle: '测试 GET/POST 请求、超时、错误响应',
        tags: ['GET', 'POST', 'timeout']
      },
      {
        path: '/pages/component-test/component-test',
        icon: '\u{1F9E9}',
        title: '组件 & AppData 测试',
        subtitle: '测试组件状态、嵌套组件、WXML 树',
        tags: ['setData', 'WXML', '组件']
      },
      {
        path: '/pages/swiper-test/swiper-test',
        icon: '\u{1F500}',
        title: 'Swiper 轮播测试',
        subtitle: '验证 swiper / swiper-item 在 WXML 面板中的层级',
        tags: ['swiper', 'swiper-item', 'WXML']
      }
    ],
    deviceInfo: {}
  },

  onLoad() {
    console.log('[Index] 页面加载')
    this.loadDeviceInfo()
  },

  onShow() {
    console.log('[Index] 页面显示')
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
      console.log('[Index] 设备信息:', info)
    } catch (e) {
      console.error('[Index] 获取设备信息失败:', e)
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
    console.log('[Index] 导航到:', path)
    wx.navigateTo({ url: path })
  }
})
