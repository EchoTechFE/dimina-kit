# 文件路径与文件系统

这页讲 devtools simulator 是怎么处理小程序代码里出现的文件路径的：你写 `wx.chooseImage` 拿到的 `tempFilePath` 长什么样、能用在哪些地方，`wx.getFileSystemManager()` 当前能不能用，以及一个跨能力共享的虚拟路径 `difile://` 是怎么工作的。

## 当前能用什么

> [!WARNING]
> `wx.getFileSystemManager()` 上每个方法目前都会 `fail` / `throw`，错误信息 `not supported by the dimina runtime`。  
> 这是与 dimina iOS / Android / Harmony 三端**真机现状**主动对齐——三端都还没挂 FSM 后端，simulator 也不能比真机走得远，否则你的代码在 devtools 跑通，上真机就崩。

你现在可以直接用这些能力：

- ✅ `wx.chooseImage` / `wx.chooseMedia` / `wx.chooseVideo` / `wx.compressImage` / `wx.downloadFile`：返回 `difile://_tmp/...` 路径
- ✅ `<image src="difile://...">` / `<video src="difile://...">` 渲染
- ✅ `wx.uploadFile`、`wx.previewImage`、`wx.saveImageToPhotosAlbum`：直接吃 `difile://` 路径
- ❌ `wx.getFileSystemManager()` 上每个方法
- ❌ 任何往 `${wx.env.USER_DATA_PATH}/...` 写入的操作（FSM 关掉就没写入入口）

底层链路已经接好，只是 FSM 入口被关掉。把 `service-apis/file/index.js` 里每个方法换回 `invokeAPI('fs<Api>', opts)` 就能一键放开。

## 三种 difile 路径

只要看到 `difile://` 开头的字符串，按第一段路径就能分类：

```
difile://_tmp/<uuid>            ← 媒体选择器产物，只读，bytes 在 renderer 内存
difile://_store/<id>.<ext>      ← saveFile 持久化产物，只读
difile://<rel>                  ← USER_DATA_PATH 用户区，可读可写
```

`_tmp/` 和 `_store/` 是 **runtime-owned 保留段**——只能由 simulator 内部产生，开发者代码写入会被拒。用户区 (`difile://<rel>`) 是唯一可读可写的命名空间。

> [!TIP]
> `wx.env.USER_DATA_PATH` 的字面值是 `'difile://'`（与 dimina 上游契约一致，不 mimic 真机的 `'wxfile://usr'`）。  
> 你拼 `${wx.env.USER_DATA_PATH}/foo.txt` 得到 `difile:///foo.txt`（三个斜线）—— resolver 在解析时自动剥除前导斜杠，与 `difile://foo.txt` 等价。

## 预览并上传选择的图片

最常见的链路。`chooseImage` 拿到的 `tempFilePath` 可以直接喂给 `<image>` 渲染、`uploadFile` 上传，不需要任何中间转换：

```js
wx.chooseImage({
  count: 1,
  success: ({ tempFilePaths }) => {
    // tempFilePaths[0] 形如 'difile://_tmp/8f3c-...-9a21'
    this.setData({ previewSrc: tempFilePaths[0] })

    wx.uploadFile({
      url: 'https://api.example.com/upload',
      filePath: tempFilePaths[0],
      name: 'file',
    })
  },
})
```

幕后发生的事：

1. `chooseImage` 在 renderer 拿到用户选的 Blob，分配 `difile://_tmp/<uuid>` 写入 renderer `Map<string, Blob>`
2. 后台异步把 bytes 同步到 main 进程的 store（IPC `simulator:temp-file:write`）
3. `<image src="difile://_tmp/...">` 触发 webview GET → main 进程 `protocol.handle('difile')` 命中 store → 200 + 正确 MIME
4. `wx.uploadFile` 在 renderer 直接拿 Blob 拼 multipart，零跨进程拷贝

## 持久化与读回（FSM 放开后）

> [!WARNING]
> 下面的代码示例描述的是 FSM 启用后的行为。**当前所有这些调用都会 fail / throw**，因为 service 层注入被关掉了（见上一节）。底层支持已经写好，等上游 dimina 三端把 FSM 后端补齐后会一并启用。

把临时文件转成持久文件用 `saveFile`，它是 **copy 而不是 move**——源 `_tmp` 路径仍然可读：

```js
const fsm = wx.getFileSystemManager()

fsm.saveFile({
  tempFilePath: 'difile://_tmp/8f3c-...',
  success: ({ savedFilePath }) => {
    // savedFilePath 形如 'difile://_store/3a90-...-cdf2.jpg'
    wx.setStorageSync('avatar', savedFilePath)
  },
})

fsm.readFile({
  filePath: wx.getStorageSync('avatar'),
  success: ({ data }) => { /* data 是 Buffer */ },
})

fsm.removeSavedFile({
  filePath: 'difile://_store/3a90-...-cdf2.jpg',
})
```

`_store/` 是只读保留段，`removeSavedFile` 是唯一合法的删除入口；用 `unlink` 删 `_store` 会 `permission denied`。

## 写入用户数据目录

`difile://<rel>`（没有 `_tmp/` 或 `_store/` 前缀）是唯一可写的区域，落盘到 `~/.dimina/files/` 下：

```js
const fsm = wx.getFileSystemManager()
const USER = wx.env.USER_DATA_PATH  // 'difile://'

fsm.writeFile({
  filePath: `${USER}/notes/2026/q1.json`,
  data: JSON.stringify({ foo: 1 }),
  encoding: 'utf8',
})
```

> [!WARNING]
> 写类 API（`writeFile` / `appendFile` / `unlink` / `mkdir` / `rmdir` / `rename` 的 destPath / `copyFile` 的 destPath / `truncate`）拒绝任何 `_tmp/` 或 `_store/` 开头的 vpath，返回 `'<api>:fail permission denied'`。  
> 大小写敏感：`_TMP/foo` 不算保留段，会落回用户区。

测试覆盖与 `~/.dimina/files/` 隔离：把 `DIMINA_HOME=/tmp/foo` 写到环境变量，沙箱根目录就改为 `/tmp/foo/files/`，每次 vpath 解析时动态查询。

## 避免传入无效路径

`resolveVPath` 是唯一的输入校验器，所有 FSM 方法 + main 端 `protocol.handle` 共用。下面这些输入会被拒（FSM API 返回 fail，`<image src>` 返回 404）：

| 输入示例 | 拒绝原因 |
|---|---|
| `/etc/passwd` / `file:///etc/passwd` / `http://...` | URL 不以 `difile://` 开头 |
| `difile://` / `difile:///` | 路径段为空 |
| `difile://abc%` / `difile://%xx` | URL-encode 解码失败 |
| `difile://../etc/passwd` | 包含 `..` 段 |
| `difile://a/./b` | 包含 `.` 段 |
| `difile://%2e%2e/passwd` | URL-encoded 的 `..` |
| `difile://abc%00.txt` | NUL 字节会让 Node `fs.*` 抛 `TypeError`，绕过 fail callback |
| `difile://abc/..\windows` | 反斜杠在 POSIX 主机上的 traversal 偷渡 |

`rename` 会同时校验源路径和目标路径，任一边落在 `_tmp/` 或 `_store/` 都会 `permission denied`——unix `rename` 会删源文件，所以源也得是可写的。

canonicalize 完成后还要确认结果落在 sandbox base 内；跨进程的 `simulator:fs:*` IPC 通道还会再走一次 `fs.realpath`，跟链路上的所有符号链接，任一祖先指向 sandbox 外即拒绝。

## 与微信小程序的对齐

simulator 在文件这块**主动选择对齐上游 dimina，而不是 wx 真机**。结果是大多数语义和真机等价（开发者代码可移植），少数字面值不同。

**语义对齐的部分：**

- `<image src="...">` / `<video src="...">` 渲染 ：原生 scheme handler ↔ Electron `protocol.handle` + 完整 HTTP 语义（200 / 206 / 304 / 404 / 416 / Range / ETag / Cache-Control: immutable）
- `saveFile`：源仍可读的 copy 语义
- runtime-owned 命名空间只读：往 `_tmp` / `_store` 写入会失败
- 路径逃逸防御：`..` / 绝对路径 / URL 编码 traversal 一律拒
- `wx.uploadFile`：吃 `difile://_tmp/...` 直接走 renderer Blob，零跨进程拷贝

**主动差异：**

- `wx.env.USER_DATA_PATH` 字面值是 `'difile://'`（dimina 上游契约），不是 wx 真机的 `'wxfile://usr'`。开发者代码拼 `${USER_DATA_PATH}/foo` 仍然可移植；只是直接 `console.log` 看到的字面值不同。
- 保留段用**路径段**（`_tmp/` `_store/`）而不是 wx 的命名前缀（`tmp_` `store_`）。dimina 一致采用路径段风格，下划线前缀也避开了开发者真实文件命名。
- 同步 API（`*Sync`）、fd 系列（open / close / read / write / fstat / ftruncate）、`readZipEntry` / `readCompressedFile` / `unzip` 不实现，会 throw 或 fail。

## 排查 difile 请求时看哪里

实现分布在 renderer / preload / main 三个进程：

```
                                main process
                              ┌──────────────────────────┐
   chooseImage                │ Map<string, {bytes,mime}>│ ← IPC simulator:temp-file:write
        ↓                     │ (FIFO cap 200)           │
  createTempFilePath          │                          │
   (renderer)                 │ protocol.handle('difile')│
        ↓                     │   ├ _tmp → tempStore     │ ← 200 / 206 (Range) /
  Map<string, Blob> ─IPC───►  │   ├ _store → disk.ts     │   304 (If-None-Match) /
   (renderer service-side     │   └ usr   → disk.ts      │   404 (miss) /
    uploadFile 直读 Blob)      └──────────────────────────┘   416 (Range 越界)
                                          ↑
   ┌──────────────────┐                   │
   │ <image src=      │ ─── webview GET ──┘
   │  "difile://...">  │
   └──────────────────┘

   FileSystemManager.<api> (renderer)
        ↓ resolveVPath → kind 分流
        ├ tmp        → renderer Blob Map → arrayBuffer
        └ store/usr  → renderer Node fs（Electron renderer 直拿 fs）
```

`_tmp` 写入是异步的（`Blob.arrayBuffer()` → `ipcRenderer.send`），但 renderer 拿到 vpath 就会立刻把它喂给 `<img.src>` 触发 GET。如果 GET 早于 IPC 落地，`protocol.handle` 会 park 在 per-url 等待器上，等 `simulator:temp-file:write` 到达时 drain；最长等 500 毫秒，超时返 404。

模块分布：

| 模块 | 文件 |
|---|---|
| vpath 校验器 | `src/simulator/vpath.ts` |
| renderer temp store | `src/simulator/temp-files.ts` |
| renderer FSM 入口 | `src/simulator/simulator-api-fs.ts` |
| FSM 声明（被禁的那层） | `src/simulator/service-apis/file/index.js` |
| preload IPC sink | `src/preload/runtime/temp-files.ts` |
| main 端 store + protocol.handle | `src/main/services/simulator-temp-files/{index,store,resolver}.ts` |
| main 端磁盘读写 | `src/main/services/simulator-temp-files/disk.ts` |
| main 端 HTTP dispatcher | `src/main/services/simulator-temp-files/request-handler.ts` |
| main 端 fs IPC（含 symlink-safe sandbox 校验） | `src/main/services/simulator-temp-files/fs-channels.ts` |

## 已知限制

你可能在 dev 时碰到的：

- **`_tmp` 文件不跨项目持久**：单进程 FIFO 容量 200，新文件进、旧文件被挤掉。
- **多项目共享同一个用户区**：所有项目落到同一份 `~/.dimina/files/`，没有按 appId 隔离。
- **超大文件未优化**：renderer Blob + IPC + main Buffer 三份内存拷贝；`disk.readDiskFile` 读全文不切片。dev 场景一般没事，单文件几百 MB 时要小心。

实现层面（一般你不需要操心）：

- `difile://` 协议只在 `persist:simulator` session 内有效，外部 webContents 拿不到资源。
- `416` 响应不带 ETag / Cache-Control（其他 200/206 路径都带）；`_tmp` 条目无 ETag（bytes 在内存里，没有 mtime 可签）。
- FSM IO 留在 renderer 端（直接调 Node `fs`），未走 main 端 IPC——把 simulator 视为可信代码的现状如果改了，需要把这条路径下沉。

## 关联参考

- 上游真机：[`dimina/iOS/.../DMPFileUtil.swift`](../../../dimina/iOS/dimina/DiminaKit/Utils/DMPFileUtil.swift)、[`dimina/harmony/.../DMPFileUrlConvertor.ets`](../../../dimina/harmony/dimina/src/main/ets/Bundle/Util/DMPFileUrlConvertor.ets)、[`dimina/iOS/.../DifileURLSchemeHandler.swift`](../../../dimina/iOS/dimina/DiminaKit/Render/DifileURLSchemeHandler.swift)
- WeChat 官方：[文件系统](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/file-system.html) / [FileSystemManager](https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.html)
