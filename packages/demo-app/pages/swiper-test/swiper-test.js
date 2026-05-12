Page({
  data: {
    indicatorDots: true
  },

  onLoad() {
    console.log('[SwiperTest] 页面加载')
  },

  toggleDots() {
    this.setData({ indicatorDots: !this.data.indicatorDots })
  }
})
