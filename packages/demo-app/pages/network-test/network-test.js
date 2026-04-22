Page({
  data: {
    loading: false,
    lastResponse: '',
    lastError: '',
    lastStatus: 0,
    lastDuration: 0
  },

  onLoad() {
    console.log('[NetworkTest] 页面加载')
  },

  _makeRequest(options) {
    var self = this
    var startTime = Date.now()

    self.setData({
      loading: true,
      lastResponse: '',
      lastError: '',
      lastStatus: 0,
      lastDuration: 0
    })

    console.log('[NetworkTest] 发起请求:', options.method || 'GET', options.url)

    wx.request({
      url: options.url,
      method: options.method || 'GET',
      data: options.data || {},
      header: options.header || { 'Content-Type': 'application/json' },
      timeout: options.timeout || 30000,
      success: function (res) {
        var duration = Date.now() - startTime
        var responseStr = typeof res.data === 'object'
          ? JSON.stringify(res.data, null, 2)
          : String(res.data)

        self.setData({
          loading: false,
          lastStatus: res.statusCode,
          lastDuration: duration,
          lastResponse: responseStr.substring(0, 1000)
        })
        console.log('[NetworkTest] 响应:', res.statusCode, '耗时:', duration + 'ms')
        console.log('[NetworkTest] 数据:', res.data)
      },
      fail: function (err) {
        var duration = Date.now() - startTime
        self.setData({
          loading: false,
          lastDuration: duration,
          lastError: err.errMsg || '请求失败'
        })
        console.error('[NetworkTest] 请求失败:', err)
      }
    })
  },

  // ===== GET 请求 =====

  requestGet() {
    this._makeRequest({
      url: 'https://httpbin.org/get'
    })
  },

  requestGetWithParams() {
    this._makeRequest({
      url: 'https://httpbin.org/get?name=devtools&version=1.0&lang=zh'
    })
  },

  requestGetJson() {
    this._makeRequest({
      url: 'https://httpbin.org/json'
    })
  },

  // ===== POST 请求 =====

  requestPost() {
    this._makeRequest({
      url: 'https://httpbin.org/post',
      method: 'POST',
      data: {
        username: 'devtools_test',
        action: 'submit',
        timestamp: Date.now()
      }
    })
  },

  requestPostJson() {
    this._makeRequest({
      url: 'https://httpbin.org/post',
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      data: {
        items: [
          { id: 1, name: '测试项目 A', price: 99.9 },
          { id: 2, name: '测试项目 B', price: 199.0 }
        ],
        total: 298.9,
        currency: 'CNY'
      }
    })
  },

  // ===== 异常场景 =====

  requestTimeout() {
    this._makeRequest({
      url: 'https://httpbin.org/delay/10',
      timeout: 3000
    })
  },

  request404() {
    this._makeRequest({
      url: 'https://httpbin.org/status/404'
    })
  },

  request500() {
    this._makeRequest({
      url: 'https://httpbin.org/status/500'
    })
  },

  requestInvalidUrl() {
    this._makeRequest({
      url: 'https://this-domain-does-not-exist-12345.com/api'
    })
  },

  // ===== 批量请求 =====

  requestParallel() {
    var self = this
    console.log('[NetworkTest] 开始并发 5 个请求')
    self.setData({ loading: true, lastResponse: '', lastError: '' })

    var completed = 0
    var results = []

    for (var i = 1; i <= 5; i++) {
      ;(function (index) {
        wx.request({
          url: 'https://httpbin.org/get?request=' + index,
          success: function (res) {
            results.push('请求 #' + index + ': ' + res.statusCode)
            console.log('[NetworkTest] 并发请求 #' + index + ' 完成:', res.statusCode)
          },
          fail: function (err) {
            results.push('请求 #' + index + ': 失败')
            console.error('[NetworkTest] 并发请求 #' + index + ' 失败:', err)
          },
          complete: function () {
            completed++
            if (completed === 5) {
              self.setData({
                loading: false,
                lastResponse: '并发结果:\n' + results.join('\n')
              })
              console.log('[NetworkTest] 所有并发请求完成')
            }
          }
        })
      })(i)
    }
  },

  requestSequential() {
    var self = this
    console.log('[NetworkTest] 开始顺序请求')
    self.setData({ loading: true, lastResponse: '', lastError: '' })

    var results = []

    function makeRequest(index, callback) {
      wx.request({
        url: 'https://httpbin.org/get?step=' + index,
        success: function (res) {
          results.push('步骤 ' + index + ': ' + res.statusCode)
          console.log('[NetworkTest] 顺序请求步骤', index, '完成')
          callback()
        },
        fail: function (err) {
          results.push('步骤 ' + index + ': 失败')
          console.error('[NetworkTest] 顺序请求步骤', index, '失败:', err)
          callback()
        }
      })
    }

    makeRequest(1, function () {
      makeRequest(2, function () {
        makeRequest(3, function () {
          self.setData({
            loading: false,
            lastResponse: '顺序结果:\n' + results.join('\n')
          })
          console.log('[NetworkTest] 所有顺序请求完成')
        })
      })
    })
  }
})
