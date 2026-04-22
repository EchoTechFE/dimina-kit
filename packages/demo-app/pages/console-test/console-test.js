Page({
  data: {
    timerRunning: false,
    timerCount: 0
  },

  _timerId: null,

  onLoad() {
    console.log('[ConsoleTest] 页面加载')
  },

  onUnload() {
    this.stopTimer()
  },

  // ===== console.log =====

  logString() {
    console.log('这是一条字符串日志')
    console.log('Hello, DevTools!')
    console.log('中文字符串测试：你好世界')
  },

  logNumber() {
    console.log(42)
    console.log(3.14159)
    console.log(-100)
    console.log(Infinity)
    console.log(NaN)
  },

  logObject() {
    console.log({
      name: '张三',
      age: 28,
      address: {
        city: '北京',
        district: '朝阳区'
      },
      isActive: true,
      score: null
    })
  },

  logArray() {
    console.log([1, 2, 3, 4, 5])
    console.log(['苹果', '香蕉', '橘子'])
    console.log([{ id: 1, name: 'A' }, { id: 2, name: 'B' }])
  },

  logMultiple() {
    console.log('用户信息:', '张三', 28, { role: 'admin' })
    console.log('计算结果:', 1 + 2, '=', 3)
  },

  logNested() {
    console.log({
      level1: {
        level2: {
          level3: {
            level4: {
              value: '深层嵌套数据',
              array: [1, [2, [3, [4]]]]
            }
          }
        }
      }
    })
  },

  // ===== console.warn =====

  logWarn() {
    console.warn('这是一条警告信息')
    console.warn('Storage 使用量已超过 80%')
  },

  logWarnObject() {
    console.warn('配置可能有问题:', {
      timeout: 0,
      retries: -1,
      endpoint: ''
    })
  },

  // ===== console.error =====

  logError() {
    console.error('这是一条错误信息')
    console.error('网络请求失败: 404 Not Found')
  },

  logErrorObject() {
    const err = new Error('自定义错误消息')
    console.error('捕获到错误:', err)
    console.error('错误详情:', {
      code: 'ERR_NETWORK',
      message: '连接超时',
      timestamp: Date.now()
    })
  },

  // ===== console.info / debug =====

  logInfo() {
    console.info('这是一条信息日志')
    console.info('当前版本: v1.0.0')
    console.info('环境: development')
  },

  logDebug() {
    console.debug('这是一条调试日志')
    console.debug('渲染耗时: 16ms')
    console.debug('组件树深度: 5')
  },

  // ===== 异常测试 =====

  triggerUncaughtError() {
    console.log('[ConsoleTest] 即将触发未捕获异常...')
    setTimeout(function () {
      // 故意引用未定义的变量
      undefinedVariable.someMethod()
    }, 100)
  },

  triggerUnhandledRejection() {
    console.log('[ConsoleTest] 即将触发未处理的 Promise 拒绝...')
    new Promise(function (resolve, reject) {
      reject(new Error('未处理的 Promise 拒绝'))
    })
  },

  triggerTypeError() {
    console.log('[ConsoleTest] 即将触发 TypeError...')
    try {
      null.toString()
    } catch (e) {
      console.error('捕获到 TypeError:', e.message)
      // 再抛一个未捕获的
      setTimeout(function () {
        var obj = undefined
        obj.property
      }, 100)
    }
  },

  triggerReferenceError() {
    console.log('[ConsoleTest] 即将触发 ReferenceError...')
    setTimeout(function () {
      nonExistentFunction()
    }, 100)
  },

  // ===== 定时输出 =====

  startTimer() {
    var self = this
    self.setData({ timerRunning: true, timerCount: 0 })
    console.log('[ConsoleTest] 定时器已启动')

    self._timerId = setInterval(function () {
      var count = self.data.timerCount + 1
      self.setData({ timerCount: count })
      console.log('[Timer] 第 ' + count + ' 条 - 时间戳: ' + new Date().toLocaleTimeString())
    }, 2000)
  },

  stopTimer() {
    if (this._timerId) {
      clearInterval(this._timerId)
      this._timerId = null
    }
    this.setData({ timerRunning: false })
    console.log('[ConsoleTest] 定时器已停止，共输出 ' + this.data.timerCount + ' 条')
  },

  // ===== 批量输出 =====

  logBatch() {
    console.log('[ConsoleTest] 开始批量输出 50 条日志...')
    for (var i = 1; i <= 50; i++) {
      console.log('[Batch] 日志 #' + i + ' - ' + new Date().toISOString())
    }
    console.log('[ConsoleTest] 批量输出完成')
  },

  logMixed() {
    console.log('[Mixed] 普通日志')
    console.info('[Mixed] 信息日志')
    console.warn('[Mixed] 警告日志')
    console.error('[Mixed] 错误日志')
    console.debug('[Mixed] 调试日志')
    console.log('[Mixed] 对象:', { key: 'value' })
    console.warn('[Mixed] 数组:', [1, 2, 3])
    console.error('[Mixed] Error:', new Error('测试错误'))
    console.info('[Mixed] 布尔值:', true, false)
    console.log('[Mixed] 混合输出完成')
  }
})
