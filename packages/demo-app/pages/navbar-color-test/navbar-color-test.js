// wx.setNavigationBarColor / setNavigationBarTitle / showNavigationBarLoading 的效果页。
// frontColor 只接受 #ffffff 和 #000000；状态栏文字颜色应跟着 frontColor 一起变。
const PRESETS = [
  { name: '白字 · 深灰', frontColor: '#ffffff', backgroundColor: '#1f2937' },
  { name: '黑字 · 浅灰', frontColor: '#000000', backgroundColor: '#f5f5f5' },
  { name: '白字 · 品牌蓝', frontColor: '#ffffff', backgroundColor: '#4A90D9' },
  { name: '黑字 · 暖黄', frontColor: '#000000', backgroundColor: '#ffd666' },
  { name: '白字 · 玫红', frontColor: '#ffffff', backgroundColor: '#eb2f96' }
]

Page({
  data: {
    presets: PRESETS,
    current: { frontColor: '#ffffff', backgroundColor: '#1f2937' },
    lastResult: '（尚未调用）',
    loading: false,
    titleCount: 0
  },

  onLoad() {
    console.log('[NavBarColor] 页面加载')
  },

  applyPreset(e) {
    const preset = PRESETS[Number(e.currentTarget.dataset.index)]
    this.setColor(preset.frontColor, preset.backgroundColor)
  },

  applyAnimated() {
    const next = this.data.current.backgroundColor === '#722ed1' ? '#13c2c2' : '#722ed1'
    this.setColor('#ffffff', next, { duration: 600, timingFunc: 'easeInOut' })
  },

  applyInvalidFront() {
    // 非法 frontColor：官方只允许 #ffffff / #000000，这里故意传红色看回调怎么报
    this.setColor('#ff0000', '#1f2937')
  },

  setColor(frontColor, backgroundColor, animation) {
    const params = { frontColor, backgroundColor }
    if (animation) params.animation = animation
    console.log('[NavBarColor] setNavigationBarColor', params)
    wx.setNavigationBarColor({
      ...params,
      success: (res) => {
        console.log('[NavBarColor] success', res)
        this.setData({
          current: { frontColor, backgroundColor },
          lastResult: `success: ${JSON.stringify(params)}`
        })
      },
      fail: (err) => {
        console.error('[NavBarColor] fail', err)
        this.setData({ lastResult: `fail: ${err && err.errMsg ? err.errMsg : JSON.stringify(err)}` })
      }
    })
  },

  changeTitle() {
    const titleCount = this.data.titleCount + 1
    const title = `标题已改 ${titleCount} 次`
    wx.setNavigationBarTitle({
      title,
      success: () => this.setData({ titleCount, lastResult: `setNavigationBarTitle: ${title}` }),
      fail: (err) => this.setData({ lastResult: `setNavigationBarTitle fail: ${err && err.errMsg}` })
    })
  },

  toggleLoading() {
    const loading = !this.data.loading
    if (loading) {
      wx.showNavigationBarLoading()
    } else {
      wx.hideNavigationBarLoading()
    }
    this.setData({ loading, lastResult: loading ? 'showNavigationBarLoading' : 'hideNavigationBarLoading' })
  },

  goCustomNav() {
    wx.navigateTo({ url: '/pages/fullscreen-test/fullscreen-test' })
  }
})
