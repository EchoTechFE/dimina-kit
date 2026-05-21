// 音频事件桥端到端验证页
//
// onLoad 里用 wx.createInnerAudioContext() 建一个 InnerAudioContext，
// 注册 onCanplay/onPlay/onTimeUpdate/onEnded/onError，每个回调 setData
// 一个标志/计数。容器侧 HTMLAudioElement 的 DOM 事件经事件桥回传到
// service 侧的这些 onXxx 回调，e2e 通过页面 data 里出现的标志来证明桥通了。
//
// src 用一段极小静音 WAV 的 data: URI（与 pages/audio-test/silence.wav
// 同一份字节，base64 内联）。dimina 编译器只把 png/jpg/gif/svg 类资源
// 拷进产物，不处理 JS 里引用的 .wav，所以这里用自包含的 data URI，
// 容器的 Audio 元素可直接解码，无需依赖资源拷贝。canplay/loadedmetadata
// 在资源 load 完即触发，不需要用户手势。
var SILENCE_WAV_DATA_URI = 'data:audio/wav;base64,UklGRoQJAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YWAJAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIA='

Page({
  data: {
    audioReady: false,
    canplayFired: false,
    playFired: false,
    endedFired: false,
    errorFired: false,
    timeUpdateCount: 0,
    lastEvent: '',
    duration: 0,
    errMsg: ''
  },

  _ctx: null,

  onLoad: function () {
    console.log('[AudioTest] 页面加载，创建 InnerAudioContext')
    var self = this
    var ctx = wx.createInnerAudioContext()
    this._ctx = ctx

    ctx.onCanplay(function (e) {
      console.log('[AudioTest] onCanplay', e)
      self.setData({
        canplayFired: true,
        audioReady: true,
        lastEvent: 'canplay',
        duration: (e && e.duration) || ctx.duration || 0
      })
    })

    ctx.onPlay(function (e) {
      console.log('[AudioTest] onPlay', e)
      self.setData({ playFired: true, lastEvent: 'play' })
    })

    ctx.onTimeUpdate(function (e) {
      self.setData({
        timeUpdateCount: self.data.timeUpdateCount + 1,
        lastEvent: 'timeUpdate'
      })
    })

    ctx.onEnded(function (e) {
      console.log('[AudioTest] onEnded', e)
      self.setData({ endedFired: true, lastEvent: 'ended' })
    })

    ctx.onError(function (e) {
      console.error('[AudioTest] onError', e)
      self.setData({
        errorFired: true,
        lastEvent: 'error',
        errMsg: (e && (e.errMsg || e.message)) || 'audio error'
      })
    })

    // 设 src 会触发容器侧 Audio 元素 load，进而回传 canplay。
    ctx.src = SILENCE_WAV_DATA_URI
  },

  onUnload: function () {
    if (this._ctx) {
      this._ctx.destroy()
      this._ctx = null
    }
  },

  // 备用：需要用户手势时点这个按钮触发 play()
  playAudio: function () {
    console.log('[AudioTest] 点击播放')
    if (this._ctx) {
      this._ctx.play()
    }
  }
})
