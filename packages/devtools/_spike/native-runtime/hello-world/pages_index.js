modDefine('pages/index/index', function(require, module, exports) {
  Module({
    path: 'pages/index/index',
    id: 'poc-index',
    usingComponents: {},
    tplComponents: {},
    render: function render(_ctx, _cache) {
      const _component_dd_view = _resolveComponent('dd-view')
      const _component_dd_button = _resolveComponent('dd-button')
      return (_openBlock(), _createElementBlock('div', { class: 'index-page' }, [
        _createVNode(_component_dd_view, { class: 'hero' }, {
          default: _withCtx(() => [
            _createElementVNode('div', { class: 'msg' }, _toDisplayString(_ctx.msg), 1),
            _createElementVNode('div', { class: 'count' }, 'count: ' + _toDisplayString(_ctx.count), 1),
          ]),
          _: 1,
        }),
        _createVNode(_component_dd_button, {
          type: 'primary',
          bindtap: 'handleTap',
          class: 'tap-button',
        }, {
          default: _withCtx(() => [
            _createTextVNode('Increment'),
          ]),
          _: 1,
        }),
      ]))
    },
  })
})
