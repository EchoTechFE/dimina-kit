// Records every gesture event the framework delivers, so the e2e can assert on
// the real payload rather than on a mocked bridge.

function snapshotTouch(touch) {
  if (!touch) return null
  return {
    identifier: touch.identifier,
    x: touch.x,
    y: touch.y,
    pageX: touch.pageX,
    pageY: touch.pageY,
    clientX: touch.clientX,
    clientY: touch.clientY,
  }
}

function snapshotEvent(e) {
  return {
    type: e.type,
    hasCurrentTarget: Object.prototype.hasOwnProperty.call(e, 'currentTarget'),
    detail: e.detail || null,
    touch0: snapshotTouch(e.touches && e.touches[0]),
    changed0: snapshotTouch(e.changedTouches && e.changedTouches[0]),
    touchCount: (e.touches || []).length,
  }
}

const EMPTY = {
  log: [],
  canvasTouchStart: null,
  canvasTouchEnd: null,
  canvasTap: null,
  canvasCancelTap: null,
  canvasLongPress: null,
  outerTouchEnd: null,
  outerTap: null,
  catchButtonTap: null,
  catchOuterTap: null,
}

Page({
  data: Object.assign({}, EMPTY),

  onReset() {
    this.setData(Object.assign({}, EMPTY, { log: [] }))
  },

  record(name, e, key) {
    const log = this.data.log.slice()
    log.push(name)
    const patch = { log: log }
    patch[key] = snapshotEvent(e)
    this.setData(patch)
  },

  onCanvasTouchStart(e) {
    this.record('canvas:touchstart', e, 'canvasTouchStart')
  },
  onCanvasTouchEnd(e) {
    this.record('canvas:touchend', e, 'canvasTouchEnd')
  },
  onCanvasTap(e) {
    this.record('canvas:tap', e, 'canvasTap')
  },
  onCanvasCancelTap(e) {
    this.record('canvas:canceltap', e, 'canvasCancelTap')
  },
  onCanvasLongPress(e) {
    this.record('canvas:longpress', e, 'canvasLongPress')
  },
  onOuterTouchEnd(e) {
    this.record('outer:touchend', e, 'outerTouchEnd')
  },
  onOuterTap(e) {
    this.record('outer:tap', e, 'outerTap')
  },
  onCatchButtonTap(e) {
    this.record('catch:button', e, 'catchButtonTap')
  },
  onCatchOuterTap(e) {
    this.record('catch:outer', e, 'catchOuterTap')
  },
})
