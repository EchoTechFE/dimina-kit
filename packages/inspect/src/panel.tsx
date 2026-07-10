// Public React entry (`@dimina-kit/inspect/panel`): the pure views plus the
// source-connected containers. Split into files so a pure view stays
// importable without its data-wiring layer.
export { WxmlPanel } from './panel-view.js'
export { ConnectedWxmlPanel, type ConnectedWxmlPanelProps } from './connected-panel.js'
export { StoragePanel, type StoragePanelProps } from './storage-panel-view.js'
export { ConnectedStoragePanel, type ConnectedStoragePanelProps } from './connected-storage-panel.js'
