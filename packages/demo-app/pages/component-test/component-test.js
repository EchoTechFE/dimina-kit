var messages = [
  '你好世界',
  'Hello DevTools',
  '组件状态已更新',
  '数据变化中...',
  '测试 setData 响应'
]

Page({
  data: {
    message: '初始消息',
    count: 0,
    timestamp: '',
    list: [],
    nestingDepth: 3,
    nestedData: {
      label: '根节点',
      color: '#4A90D9',
      children: [
        {
          label: '子节点 A',
          color: '#52c41a',
          children: [
            { label: '孙节点 A-1', color: '#faad14', children: [] },
            { label: '孙节点 A-2', color: '#ff4d4f', children: [] }
          ]
        },
        {
          label: '子节点 B',
          color: '#722ed1',
          children: [
            { label: '孙节点 B-1', color: '#13c2c2', children: [] }
          ]
        }
      ]
    },
    showBlock: true,
    showAlternate: false
  },

  _listIdCounter: 0,

  onLoad() {
    console.log('[ComponentTest] 页面加载')
    this.setData({ timestamp: new Date().toLocaleTimeString() })
  },

  // ===== 页面 setData =====

  updateMessage() {
    var idx = Math.floor(Math.random() * messages.length)
    this.setData({ message: messages[idx] })
    console.log('[ComponentTest] 消息更新为:', messages[idx])
  },

  incrementCount() {
    var newCount = this.data.count + 1
    this.setData({ count: newCount })
    console.log('[ComponentTest] 计数更新为:', newCount)
  },

  updateTimestamp() {
    var ts = new Date().toLocaleTimeString()
    this.setData({ timestamp: ts })
    console.log('[ComponentTest] 时间戳更新为:', ts)
  },

  updateAll() {
    var idx = Math.floor(Math.random() * messages.length)
    this.setData({
      message: messages[idx],
      count: this.data.count + 1,
      timestamp: new Date().toLocaleTimeString()
    })
    console.log('[ComponentTest] 批量更新所有字段')
  },

  // ===== Counter 组件事件 =====

  onCounterChange(e) {
    console.log('[ComponentTest] Counter 变化:', e.detail)
  },

  // ===== 动态列表 =====

  addListItem() {
    this._listIdCounter++
    var newItem = {
      id: this._listIdCounter,
      title: '列表项 #' + this._listIdCounter,
      time: new Date().toLocaleTimeString()
    }
    var list = this.data.list.concat([newItem])
    this.setData({ list: list })
    console.log('[ComponentTest] 添加列表项:', newItem)
  },

  removeLastItem() {
    var list = this.data.list.slice(0, -1)
    this.setData({ list: list })
    console.log('[ComponentTest] 移除最后一项，剩余:', list.length)
  },

  removeItem(e) {
    var index = e.currentTarget.dataset.index
    var list = this.data.list.filter(function (_, i) { return i !== index })
    this.setData({ list: list })
    console.log('[ComponentTest] 移除第', index + 1, '项')
  },

  shuffleList() {
    var list = this.data.list.slice()
    for (var i = list.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1))
      var temp = list[i]
      list[i] = list[j]
      list[j] = temp
    }
    this.setData({ list: list })
    console.log('[ComponentTest] 列表随机排序')
  },

  // ===== 嵌套组件 =====

  increaseNesting() {
    var depth = Math.min(this.data.nestingDepth + 1, 6)
    this.setData({ nestingDepth: depth })
    console.log('[ComponentTest] 嵌套深度增加到:', depth)
  },

  decreaseNesting() {
    var depth = Math.max(this.data.nestingDepth - 1, 1)
    this.setData({ nestingDepth: depth })
    console.log('[ComponentTest] 嵌套深度减少到:', depth)
  },

  // ===== 条件渲染 =====

  toggleVisibility() {
    this.setData({ showBlock: !this.data.showBlock })
    console.log('[ComponentTest] showBlock:', !this.data.showBlock ? '显示' : '隐藏')
  },

  toggleAlternate() {
    this.setData({ showAlternate: !this.data.showAlternate })
    console.log('[ComponentTest] showAlternate:', this.data.showAlternate)
  }
})
