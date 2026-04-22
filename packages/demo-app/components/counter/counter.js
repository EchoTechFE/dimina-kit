Component({
  properties: {
    label: {
      type: String,
      value: '计数器'
    },
    initial: {
      type: Number,
      value: 0
    },
    step: {
      type: Number,
      value: 1
    }
  },

  data: {
    value: 0
  },

  lifetimes: {
    attached: function () {
      this.setData({ value: this.properties.initial })
      console.log('[Counter] 组件已挂载, label:', this.properties.label, 'initial:', this.properties.initial)
    },
    detached: function () {
      console.log('[Counter] 组件已卸载, label:', this.properties.label)
    }
  },

  methods: {
    increment: function () {
      var newValue = this.data.value + this.properties.step
      this.setData({ value: newValue })
      console.log('[Counter]', this.properties.label, '递增到:', newValue)
      this.triggerEvent('change', { label: this.properties.label, value: newValue, action: 'increment' })
    },

    decrement: function () {
      var newValue = this.data.value - this.properties.step
      this.setData({ value: newValue })
      console.log('[Counter]', this.properties.label, '递减到:', newValue)
      this.triggerEvent('change', { label: this.properties.label, value: newValue, action: 'decrement' })
    },

    reset: function () {
      this.setData({ value: this.properties.initial })
      console.log('[Counter]', this.properties.label, '已重置为:', this.properties.initial)
      this.triggerEvent('change', { label: this.properties.label, value: this.properties.initial, action: 'reset' })
    }
  }
})
