// Public React entry (`@dimina-kit/wxml-inspect/panel`): the pure tree view
// plus the source-connected container. Split into files so the pure view
// stays importable without the data-wiring layer.
export { WxmlPanel } from './panel-view.js'
export { ConnectedWxmlPanel, type ConnectedWxmlPanelProps } from './connected-panel.js'
