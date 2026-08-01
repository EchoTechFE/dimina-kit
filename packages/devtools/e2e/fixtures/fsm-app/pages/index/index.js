/**
 * Self-test page for the wx.getFileSystemManager() / saveImageToPhotosAlbum
 * e2e parity contract. onLoad drives a real writeFile -> readFile round trip
 * (string + ArrayBuffer), confirms writeFileSync loudly throws over the
 * simulator worker bridge, checks canIUse when available, and confirms
 * saveImageToPhotosAlbum rejects a non-local (dataURL) filePath — then
 * setData()s a JSON summary that the e2e spec reads back from the rendered
 * `.fsm-result` text node. It then drives two `saveFile` closed loops: an
 * auto-minted `_store/` destination (save -> appears in getSavedFileList ->
 * removeSavedFile -> disappears) and a caller-chosen `filePath` destination
 * (save -> readFile round trip).
 *
 * Written in ES5-ish Promise-chain style (no async/await, no const/let-only
 * features beyond what the fixture apps elsewhere in this repo already use)
 * to keep the self-test independent of the compiler's transpile target.
 */

var USER_TXT_PATH = wx.env.USER_DATA_PATH + '/e2e-fsm.txt'
var USER_BIN_PATH = wx.env.USER_DATA_PATH + '/e2e-fsm.bin'
var USER_SYNC_PATH = wx.env.USER_DATA_PATH + '/e2e-fsm-sync.txt'
var USER_SAVE_SRC_PATH = wx.env.USER_DATA_PATH + '/e2e-fsm-savesrc.txt'
var USER_SAVE_TARGET_PATH = wx.env.USER_DATA_PATH + '/journey/saved.txt'

function callAsync(invoke, opts) {
  return new Promise(function (resolve) {
    var merged = Object.assign({}, opts, {
      success: function (res) { resolve({ ok: true, res: res }) },
      fail: function (res) { resolve({ ok: false, res: res }) },
    })
    invoke(merged)
  })
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false
  for (var i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

Page({
  data: {
    resultJson: '',
  },
  onLoad: function () {
    var self = this
    var fsm = wx.getFileSystemManager()
    var summary = {}
    var srcBytes = new Uint8Array([1, 2, 3, 250])

    callAsync(fsm.writeFile.bind(fsm), { filePath: USER_TXT_PATH, data: 'hello-fsm', encoding: 'utf8' })
      .then(function (write1) {
        summary.write1Ok = write1.ok
        summary.write1ErrMsg = write1.res && write1.res.errMsg
        return callAsync(fsm.readFile.bind(fsm), { filePath: USER_TXT_PATH, encoding: 'utf8' })
      })
      .then(function (read1) {
        summary.read1Ok = read1.ok
        summary.read1Data = read1.ok ? read1.res.data : null
        return callAsync(fsm.writeFile.bind(fsm), { filePath: USER_BIN_PATH, data: srcBytes.buffer })
      })
      .then(function (write2) {
        summary.write2Ok = write2.ok
        return callAsync(fsm.readFile.bind(fsm), { filePath: USER_BIN_PATH })
      })
      .then(function (read2) {
        summary.read2Ok = read2.ok
        var data = read2.ok ? read2.res.data : null
        var isArrayBuffer = !!data && Object.prototype.toString.call(data) === '[object ArrayBuffer]'
        summary.read2IsArrayBuffer = isArrayBuffer
        summary.read2BytesMatch = isArrayBuffer ? bytesEqual(srcBytes, new Uint8Array(data)) : false

        try {
          fsm.writeFileSync(USER_SYNC_PATH, 'nope', 'utf8')
          summary.writeFileSyncThrew = false
        } catch (e) {
          summary.writeFileSyncThrew = true
        }

        if (typeof wx.canIUse === 'function') {
          summary.canIUseChecked = true
          summary.canIUseWriteFile = wx.canIUse('FileSystemManager.writeFile')
          summary.canIUseWriteFileSync = wx.canIUse('FileSystemManager.writeFileSync')
        } else {
          summary.canIUseChecked = false
        }

        return callAsync(wx.saveImageToPhotosAlbum.bind(wx), { filePath: 'data:image/png;base64,iVBORw0KGgo=' })
      })
      .then(function (saveImg) {
        summary.saveImageOk = saveImg.ok
        summary.saveImageErrMsg = saveImg.res && saveImg.res.errMsg
        return callAsync(fsm.writeFile.bind(fsm), { filePath: USER_SAVE_SRC_PATH, data: 'save-me', encoding: 'utf8' })
      })
      .then(function (writeSrc) {
        summary.saveFlowWriteOk = writeSrc.ok
        return callAsync(fsm.saveFile.bind(fsm), { tempFilePath: USER_SAVE_SRC_PATH })
      })
      .then(function (saved) {
        summary.savedFileOk = saved.ok
        summary.savedFilePath = saved.ok ? saved.res.savedFilePath : null
        summary.savedFilePathIsStore = !!summary.savedFilePath && summary.savedFilePath.indexOf('difile://_store/') === 0
        return callAsync(fsm.getSavedFileList.bind(fsm), {})
      })
      .then(function (list1) {
        var files1 = (list1.ok && list1.res.fileList) || []
        summary.savedListContainsBeforeRemove = files1.some(function (f) { return f.filePath === summary.savedFilePath })
        return callAsync(fsm.removeSavedFile.bind(fsm), { filePath: summary.savedFilePath })
      })
      .then(function (removed) {
        summary.removeSavedFileOk = removed.ok
        return callAsync(fsm.getSavedFileList.bind(fsm), {})
      })
      .then(function (list2) {
        var files2 = (list2.ok && list2.res.fileList) || []
        summary.savedListContainsAfterRemove = files2.some(function (f) { return f.filePath === summary.savedFilePath })
        return callAsync(fsm.saveFile.bind(fsm), { tempFilePath: USER_SAVE_SRC_PATH, filePath: USER_SAVE_TARGET_PATH })
      })
      .then(function (savedTo) {
        summary.savedToTargetOk = savedTo.ok
        summary.savedToTargetPath = savedTo.ok ? savedTo.res.savedFilePath : null
        return callAsync(fsm.readFile.bind(fsm), { filePath: USER_SAVE_TARGET_PATH, encoding: 'utf8' })
      })
      .then(function (readTarget) {
        summary.readTargetOk = readTarget.ok
        summary.readTargetData = readTarget.ok ? readTarget.res.data : null
        self.setData({ resultJson: JSON.stringify(summary) })
      })
      .catch(function (err) {
        summary.uncaughtError = String((err && err.message) || err)
        self.setData({ resultJson: JSON.stringify(summary) })
      })
  },
})
