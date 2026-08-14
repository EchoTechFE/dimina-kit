// 1x1 opaque red PNG, generated locally (not fetched) so drawImage exercises a
// real async image decode without depending on network access.
const RED_PIXEL_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='

Page({
  data: {},

  // A single filled rect at known canvas coordinates — the base pixel-level
  // proof that logic-layer recording -> bridge -> render-layer replay lands on
  // the real DOM canvas.
  onBasicRect() {
    const ctx = wx.createCanvasContext('mainCanvas', this)
    ctx.setFillStyle('#ff0000')
    ctx.fillRect(20, 20, 60, 60)
    ctx.draw(false, () => {
      this.setData({ basicRectDone: true })
    })
  },

  // reserve semantics, phase A: paint a translated blue square with a fresh
  // CanvasContext (its own recording state, independent of what any other
  // handler used).
  onReserveBatchA() {
    const ctx = wx.createCanvasContext('mainCanvas', this)
    ctx.setFillStyle('#0000ff')
    ctx.translate(50, 50)
    ctx.fillRect(0, 0, 40, 40)
    ctx.draw(false, () => {
      this.setData({ reserveBatchADone: true })
    })
  },

  // reserve semantics, phase B: draw(false) must reset the REAL render-side
  // canvas state before replay — this handler deliberately records no
  // fillStyle/translate of its own, so a leaked blue fillStyle or leaked
  // translate(50, 50) from phase A would be a render-layer bug, not something
  // this handler could cause itself.
  onReserveBatchBReset() {
    const ctx = wx.createCanvasContext('mainCanvas', this)
    ctx.fillRect(0, 0, 40, 40)
    ctx.draw(false, () => {
      this.setData({ reserveBatchBDone: true })
    })
  },

  // reserve semantics, phase C: draw(true) must NOT clear phase B's square —
  // it only appends.
  onReserveBatchCKeep() {
    const ctx = wx.createCanvasContext('mainCanvas', this)
    ctx.setFillStyle('#00aa00')
    ctx.fillRect(100, 100, 40, 40)
    ctx.draw(true, () => {
      this.setData({ reserveBatchCDone: true })
    })
  },

  // Linear gradient across the full canvas width, red -> blue. The gradient
  // description crosses the service->render bridge as a serialized object and
  // must be reconstructed into a real CanvasGradient before fillRect uses it.
  onGradient() {
    const ctx = wx.createCanvasContext('mainCanvas', this)
    const gradient = ctx.createLinearGradient(0, 0, 200, 0)
    gradient.addColorStop(0, '#ff0000')
    gradient.addColorStop(1, '#0000ff')
    ctx.setFillStyle(gradient)
    ctx.fillRect(0, 0, 200, 200)
    ctx.draw(false, () => {
      this.setData({ gradientDone: true })
    })
  },

  // measureText is synchronous and answered from the logic layer's own
  // measuring canvas, not the render layer — a doubled font size must produce
  // a visibly larger measured width for the same string.
  onMeasureFonts() {
    const ctx = wx.createCanvasContext('mainCanvas', this)
    ctx.font = '16px sans-serif'
    const small = ctx.measureText('Dimina Canvas')
    ctx.font = '48px sans-serif'
    const big = ctx.measureText('Dimina Canvas')
    this.setData({
      measureSmallWidth: small.width,
      measureBigWidth: big.width,
    })
  },

  // font reassembly puts modifier tokens in the SAME order they appeared in
  // the input, not CSS canonical (style-before-weight) order. 'bold italic …'
  // keeps weight first. A real canvas font setter may or may not accept that
  // order — this is only asserted against the internal recording state in
  // unit tests, so this case reads the font back from the real render-side
  // CanvasRenderingContext2D to confirm the browser actually accepted it
  // (a rejected assignment silently keeps the previous font instead).
  onFontAcceptWeightStyle() {
    const ctx = wx.createCanvasContext('mainCanvas', this)
    ctx.font = 'bold italic 18px Georgia'
    ctx.fillText('Dimina Canvas', 10, 100)
    ctx.draw(false, () => {
      this.setData({ fontAcceptWeightStyleDone: true })
    })
  },

  // A single modifier token ('bold') gets a trailing 'normal' appended by the
  // official reassembly rule, producing 'bold normal 16px serif' — two
  // modifier tokens where the input only had one, weight still first. Same
  // real-canvas-acceptance concern as above.
  onFontAcceptSingleModifier() {
    const ctx = wx.createCanvasContext('mainCanvas', this)
    ctx.font = 'bold 16px serif'
    ctx.fillText('Dimina Canvas', 10, 100)
    ctx.draw(false, () => {
      this.setData({ fontAcceptSingleModifierDone: true })
    })
  },

  // Two draw() batches issued back to back in the same tick. Batch 1 draws a
  // full-canvas image (a real async decode — Image.onload never fires
  // synchronously, even for a data: URI). Batch 2 is pure synchronous canvas
  // calls with no image. Per-canvas serialization must hold batch 2 until
  // batch 1's replay (including the image decode) fully finishes, so batch 2
  // — issued later — is what the final canvas shows. Without serialization,
  // batch 2 (all sync) would finish first and then get overwritten when
  // batch 1 resumes and clears the canvas again for its own reserve:false
  // replay.
  onSerialDraw() {
    const ctx1 = wx.createCanvasContext('mainCanvas', this)
    ctx1.drawImage(RED_PIXEL_DATA_URI, 0, 0, 200, 200)
    ctx1.draw(false, () => {
      this.setData({ serialBatch1Done: true })
    })

    const ctx2 = wx.createCanvasContext('mainCanvas', this)
    ctx2.setFillStyle('#00aa00')
    ctx2.fillRect(0, 0, 200, 200)
    ctx2.draw(false, () => {
      this.setData({ serialBatch2Done: true })
    })
  },

  onPathSnapshotTransform() {
    const ctx = wx.createCanvasContext('mainCanvas', this)
    ctx.beginPath()
    ctx.rect(0, 0, 30, 30)
    ctx.setFillStyle('#000000')
    ctx.fill()
    ctx.translate(60, 0)
    ctx.setFillStyle('#00aa00')
    ctx.fill()
    ctx.draw(false, () => {
      this.setData({ pathSnapshotTransformDone: true })
    })
  },

  // save() must snapshot a COPY of the drawing state, not a shared reference
  // — restore() has to actually undo the translate/fillStyle set after save().
  onSaveRestore() {
    const ctx = wx.createCanvasContext('mainCanvas', this)
    ctx.save()
    ctx.translate(60, 60)
    ctx.setFillStyle('#800080')
    ctx.fillRect(0, 0, 30, 30)
    ctx.restore()
    ctx.fillRect(0, 0, 30, 30)
    ctx.draw(false, () => {
      this.setData({ saveRestoreDone: true })
    })
  },

  // clip-lock phase A: clip to the top-left 50x50, then fill the whole
  // canvas — only the clipped region should actually take the fill color.
  onClipLockBatchA() {
    const ctx = wx.createCanvasContext('mainCanvas', this)
    ctx.beginPath()
    ctx.rect(0, 0, 50, 50)
    ctx.clip()
    ctx.setFillStyle('#ff8800')
    ctx.fillRect(0, 0, 200, 200)
    ctx.draw(false, () => {
      this.setData({ clipLockBatchADone: true })
    })
  },

  // clip-lock phase B: a fresh CanvasContext that never calls clip() itself.
  // A reserve:false draw() must fully reset the render-side clip region —
  // otherwise this fill stays locked to phase A's leftover top-left 50x50
  // clip, and the rest of the canvas can never be painted again.
  onClipLockBatchBNoClip() {
    const ctx = wx.createCanvasContext('mainCanvas', this)
    ctx.setFillStyle('#0088ff')
    ctx.fillRect(0, 0, 200, 200)
    ctx.draw(false, () => {
      this.setData({ clipLockBatchBDone: true })
    })
  },

  onExportDefaults() {
    const pixelRatio = wx.getWindowInfo().pixelRatio
    const exportAttempt = (this.data.exportAttempt || 0) + 1
    this.setData({
      exportAttempt,
      exportDone: false,
      exportBytesBase64: null,
      exportError: null,
      exportCompleteErrMsg: null,
    })
    wx.canvasToTempFilePath({
      canvasId: 'mainCanvas',
      x: 0,
      y: 0,
      width: 50,
      height: 25,
      success: (result) => {
        this.setData({
          exportPixelRatio: pixelRatio,
          exportTempFilePath: result.tempFilePath,
          exportSuccessReceived: true,
        })
        const fsm = wx.getFileSystemManager()
        fsm.readFile({
          filePath: result.tempFilePath,
          encoding: 'base64',
          success: (fileResult) => {
            this.setData({ exportBytesBase64: fileResult.data, exportCompletedAttempt: exportAttempt, exportDone: true })
          },
          fail: (error) => {
            this.setData({ exportError: error.errMsg, exportDone: true })
          },
        })
      },
      fail: (error) => {
        this.setData({ exportError: error.errMsg, exportDone: true })
      },
      complete: (result) => {
        this.setData({ exportCompleteAttempt: exportAttempt, exportCompleteErrMsg: result.errMsg, exportCompleteResult: result })
      },
    }, this)
  },

  onPixelRoundTrip() {
    this.setData({ pixelRoundTripStarted: true })
    try {
      wx.canvasPutImageData({
        canvasId: 'mainCanvas',
        x: 4,
        y: 5,
        width: 1,
        height: 1,
        data: new Uint8ClampedArray([9, 18, 27, 255]),
        success: (putResult) => {
          wx.canvasGetImageData({
            canvasId: 'mainCanvas',
            x: 4,
            y: 5,
            width: 1,
            height: 1,
            success: (getResult) => {
              this.setData({
                pixelPutErrMsg: putResult.errMsg,
                pixelGetErrMsg: getResult.errMsg,
                pixelBytes: Array.from(getResult.data),
                pixelDataType: Object.prototype.toString.call(getResult.data),
                pixelRoundTripDone: true,
              })
            },
            fail: (error) => {
              this.setData({ pixelRoundTripError: error.errMsg, pixelRoundTripDone: true })
            },
          })
        },
        fail: (error) => {
          this.setData({ pixelRoundTripError: error.errMsg, pixelRoundTripDone: true })
        },
      })
    }
    catch (error) {
      this.setData({ pixelRoundTripError: String(error), pixelRoundTripDone: true })
    }
  },

  // unbalanced-restore phase A: one more restore() than save() in the same
  // batch. A real canvas silently no-ops restore() once its state stack is
  // empty, but if the render layer relies on its own save/restore pairing to
  // reset per-batch state, an unbalanced restore from user code must not be
  // able to pop past that and corrupt the NEXT batch.
  onUnbalancedRestoreBatchA() {
    const ctx = wx.createCanvasContext('mainCanvas', this)
    ctx.save()
    ctx.translate(40, 40)
    ctx.setFillStyle('#ff8800')
    ctx.fillRect(0, 0, 20, 20)
    ctx.restore()
    ctx.restore()
    ctx.draw(false, () => {
      this.setData({ unbalancedRestoreADone: true })
    })
  },

  // unbalanced-restore phase B: a plain, unrelated fill with no save/restore
  // of its own — must render normally regardless of phase A's imbalance.
  onUnbalancedRestoreBatchBClean() {
    const ctx = wx.createCanvasContext('mainCanvas', this)
    ctx.setFillStyle('#0088ff')
    ctx.fillRect(0, 0, 30, 30)
    ctx.draw(false, () => {
      this.setData({ unbalancedRestoreBDone: true })
    })
  },
})
