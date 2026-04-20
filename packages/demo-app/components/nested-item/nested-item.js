Component({
  properties: {
    data: {
      type: Object,
      value: {
        label: '',
        color: '#ccc',
        children: []
      }
    },
    depth: {
      type: Number,
      value: 3
    },
    currentDepth: {
      type: Number,
      value: 1
    }
  },

  data: {
    expanded: true
  },

  lifetimes: {
    attached: function () {
      console.log('[NestedItem] 挂载, label:', this.properties.data.label, '深度:', this.properties.currentDepth)
    }
  },

  methods: {
    toggleExpand: function () {
      this.setData({ expanded: !this.data.expanded })
      console.log('[NestedItem]', this.properties.data.label, this.data.expanded ? '展开' : '折叠')
    }
  }
})
