Page({
  data: {
    results: []
  },

  onLoad() {
    console.log('[QdApiTest] 页面加载')
  },

  addResult(name, status, detail) {
    var results = this.data.results
    results.unshift({
      name: name,
      status: status,
      detail: typeof detail === 'object' ? JSON.stringify(detail, null, 2) : String(detail),
      time: new Date().toLocaleTimeString()
    })
    this.setData({ results: results })
  },

  // 系统信息
  testGetSystemInfo() {
    var self = this
    try {
      var info = qd.getSystemInfoSync()
      console.log('[QdApiTest] qd.getSystemInfoSync:', info)
      self.addResult('qd.getSystemInfoSync', 'success', {
        platform: info.platform,
        screenWidth: info.screenWidth,
        screenHeight: info.screenHeight
      })
    } catch (e) {
      console.error('[QdApiTest] qd.getSystemInfoSync 失败:', e)
      self.addResult('qd.getSystemInfoSync', 'fail', e.message || e)
    }
  },

  // Storage
  testStorage() {
    var self = this
    try {
      qd.setStorageSync('qd_test_key', 'hello from qd namespace')
      var value = qd.getStorageSync('qd_test_key')
      console.log('[QdApiTest] qd.setStorageSync / getStorageSync:', value)

      var match = value === 'hello from qd namespace'
      self.addResult('qd.set/getStorageSync', match ? 'success' : 'fail',
        match ? '写入读取一致: ' + value : '值不匹配: ' + value)

      qd.removeStorageSync('qd_test_key')
      var afterRemove = qd.getStorageSync('qd_test_key')
      var removed = !afterRemove && afterRemove !== 0
      self.addResult('qd.removeStorageSync', removed ? 'success' : 'fail',
        removed ? '删除成功，返回: ' + afterRemove : '删除后仍有值: ' + afterRemove)
    } catch (e) {
      console.error('[QdApiTest] Storage 测试失败:', e)
      self.addResult('qd.Storage', 'fail', e.message || e)
    }
  },

  // 网络请求
  testRequest() {
    var self = this
    console.log('[QdApiTest] qd.request 开始')
    qd.request({
      url: 'https://httpbin.org/get?from=qd-namespace',
      method: 'GET',
      success: function (res) {
        console.log('[QdApiTest] qd.request 成功:', res.statusCode)
        self.addResult('qd.request', 'success', '状态码: ' + res.statusCode)
      },
      fail: function (err) {
        console.error('[QdApiTest] qd.request 失败:', err)
        self.addResult('qd.request', 'fail', err.errMsg || '请求失败')
      }
    })
  },

  // 导航
  testNavigateTo() {
    var self = this
    console.log('[QdApiTest] qd.navigateTo')
    self.addResult('qd.navigateTo', 'success', '跳转到 console-test 页面')
    qd.navigateTo({ url: '/pages/console-test/console-test' })
  },

  // showToast
  testShowToast() {
    var self = this
    qd.showToast({
      title: 'qd.showToast 测试',
      icon: 'success'
    })
    console.log('[QdApiTest] qd.showToast')
    self.addResult('qd.showToast', 'success', '已弹出 Toast')
  },

  // showModal
  testShowModal() {
    var self = this
    qd.showModal({
      title: 'qd.showModal',
      content: '这是通过 qd 命名空间调用的 Modal',
      success: function (res) {
        console.log('[QdApiTest] qd.showModal result:', res)
        self.addResult('qd.showModal', 'success',
          res.confirm ? '用户点击确定' : '用户点击取消')
      }
    })
  },

  // 与 wx 命名空间对比
  testCompareWithWx() {
    var self = this
    var qdRef = (typeof qd !== 'undefined') ? qd : null
    var wxRef = (typeof wx !== 'undefined') ? wx : null

    if (!qdRef) {
      self.addResult('qd === wx', 'fail', 'qd 未定义')
      return
    }
    if (!wxRef) {
      self.addResult('qd === wx', 'fail', 'wx 未定义')
      return
    }

    var same = qdRef === wxRef
    console.log('[QdApiTest] qd === wx:', same)
    self.addResult('qd === wx', same ? 'success' : 'fail',
      same ? '指向同一对象，命名空间等价' : '不是同一对象')
  },

  // 运行全部测试
  testAll() {
    this.setData({ results: [] })
    this.testCompareWithWx()
    this.testGetSystemInfo()
    this.testStorage()
    this.testShowToast()
    this.testRequest()
  },

  clearResults() {
    this.setData({ results: [] })
  }
})
