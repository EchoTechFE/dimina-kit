Page({
  data: {
    inputKey: '',
    inputValue: '',
    queryKey: '',
    queryResult: null,
    storageItems: []
  },

  onLoad() {
    console.log('[StorageTest] 页面加载')
    this.refreshList()
  },

  onShow() {
    this.refreshList()
  },

  onKeyInput(e) {
    this.setData({ inputKey: e.detail.value })
  },

  onValueInput(e) {
    this.setData({ inputValue: e.detail.value })
  },

  onQueryKeyInput(e) {
    this.setData({ queryKey: e.detail.value })
  },

  setItem() {
    var key = this.data.inputKey.trim()
    var value = this.data.inputValue.trim()
    if (!key) {
      wx.showToast({ title: '请输入键名', icon: 'none' })
      return
    }
    try {
      wx.setStorageSync(key, value)
      console.log('[StorageTest] setItem:', key, '=', value)
      wx.showToast({ title: '存储成功', icon: 'success' })
      this.setData({ inputKey: '', inputValue: '' })
      this.refreshList()
    } catch (e) {
      console.error('[StorageTest] setItem 失败:', e)
      wx.showToast({ title: '存储失败', icon: 'none' })
    }
  },

  setObjectItem() {
    var key = this.data.inputKey.trim() || 'demo_object'
    var obj = {
      name: '测试对象',
      timestamp: Date.now(),
      nested: {
        array: [1, 2, 3],
        flag: true
      }
    }
    try {
      wx.setStorageSync(key, JSON.stringify(obj))
      console.log('[StorageTest] setObjectItem:', key, '=', obj)
      wx.showToast({ title: '对象已存储', icon: 'success' })
      this.refreshList()
    } catch (e) {
      console.error('[StorageTest] setObjectItem 失败:', e)
    }
  },

  getItem() {
    var key = this.data.queryKey.trim()
    if (!key) {
      wx.showToast({ title: '请输入键名', icon: 'none' })
      return
    }
    try {
      var value = wx.getStorageSync(key)
      var result = value !== '' ? String(value) : '(空值或不存在)'
      this.setData({ queryResult: result })
      console.log('[StorageTest] getItem:', key, '=', value)
    } catch (e) {
      console.error('[StorageTest] getItem 失败:', e)
      this.setData({ queryResult: '(读取失败)' })
    }
  },

  removeItem(e) {
    var key = e.currentTarget.dataset.key
    try {
      wx.removeStorageSync(key)
      console.log('[StorageTest] removeItem:', key)
      wx.showToast({ title: '已删除', icon: 'success' })
      this.refreshList()
    } catch (err) {
      console.error('[StorageTest] removeItem 失败:', err)
    }
  },

  copyValue(e) {
    var key = e.currentTarget.dataset.key
    try {
      var value = wx.getStorageSync(key)
      wx.setClipboardData({
        data: String(value),
        success: function () {
          wx.showToast({ title: '已复制', icon: 'success' })
        }
      })
    } catch (err) {
      console.error('[StorageTest] 复制失败:', err)
    }
  },

  populateDemoData() {
    var demoData = {
      'user_name': '张三',
      'user_age': '28',
      'user_city': '北京',
      'app_theme': 'light',
      'app_language': 'zh-CN',
      'last_login': new Date().toISOString(),
      'settings': JSON.stringify({
        notifications: true,
        autoSave: true,
        fontSize: 14
      })
    }
    var keys = Object.keys(demoData)
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i]
      wx.setStorageSync(k, demoData[k])
    }
    console.log('[StorageTest] 已填充示例数据:', keys.length, '条')
    wx.showToast({ title: '已填充 ' + keys.length + ' 条数据', icon: 'success' })
    this.refreshList()
  },

  populateLargeData() {
    for (var i = 1; i <= 20; i++) {
      wx.setStorageSync('item_' + (i < 10 ? '0' + i : i), '数据值 #' + i + ' - ' + Date.now())
    }
    console.log('[StorageTest] 已填充 20 条大量数据')
    wx.showToast({ title: '已填充 20 条', icon: 'success' })
    this.refreshList()
  },

  clearAll() {
    var self = this
    wx.showModal({
      title: '确认',
      content: '确定要清空所有存储数据吗？',
      success: function (res) {
        if (res.confirm) {
          try {
            wx.clearStorageSync()
            console.log('[StorageTest] 已清空所有存储')
            wx.showToast({ title: '已清空', icon: 'success' })
            self.refreshList()
          } catch (e) {
            console.error('[StorageTest] 清空失败:', e)
          }
        }
      }
    })
  },

  refreshList() {
    try {
      var info = wx.getStorageInfoSync()
      var keys = info.keys || []
      var items = []
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i]
        var value = wx.getStorageSync(key)
        var type = typeof value
        if (type === 'string' && value.length > 0) {
          try {
            JSON.parse(value)
            type = 'JSON string'
          } catch (e) {
            type = 'string'
          }
        }
        items.push({
          key: key,
          value: String(value).substring(0, 200),
          type: type
        })
      }
      this.setData({ storageItems: items })
      console.log('[StorageTest] 刷新列表，共', items.length, '项')
    } catch (e) {
      console.error('[StorageTest] 刷新列表失败:', e)
    }
  }
})
