# 浏览器内编译:fs 后端 & 并行化实验记录

> 目标:加速 web-compiler 在浏览器里的编译,并支持 editor ↔ 编译器共享源码。
> 本文档随实验持续更新。最近更新:2026-07-02。

## TL;DR(当前结论)

- **编译永远在 ZenFS `InMemory` 上跑**(快,O(1))。**绝不在 `SingleBuffer`/SAB 上直接编译**(浏览器里慢 34×)。
- **源码"真相源"用 OPFS**(浏览器原生、持久、无需 COOP/COEP、hydrate 只要 ~76ms)或 SAB;编译前把源码 **hydrate** 进 `InMemory`。
- **并行 = stage 级(与 dmcc 一致),不做页级**。三个常驻 worker 各跑一整个 stage(logic/view/style),并集。**产物 structHash 与单线程逐位相同(零发散)**,base 4.78× / vant 2.1× / genshin 1.1×(view-bound 项目 stage 级救不了,但正确)。派发+合并放 **coordinator worker**(嵌套 worker),主线程编译全程最大卡顿 2ms。
  - **为什么不页级**:页级(view 内部按页拆)对页面独立应用能 3×,但 view 编译器做 **app 级全局模块去重**(共享模块全 app 只产一次,靠运行时全局 modDefine 跨页共享;`modDefine` 幂等已核实),页级拆到独立 realm 无法协调放置 → vant 类组件库产物缺/重模块。stage 级每 stage 整 realm → view 看全部页、logic 反向注入顺序不破 → 构造上正确、与 dmcc 一致。
  - **与 dmcc 一致性 = 结构逐字节一致**(2026-07-02 六 更新):`test:compare` 三项目 **node/single/stage structHash 三者同一 hash**、`stage vs node` 结构 5/5·111/111·495/495;`diff-web-node` 四项目 **`realToolchainDiffs: 0`**——所有还在差的文件都是 delta=0(长度相同),只差随机 scoped id(data-v / scoped keyframe 名 / view 局部变量名),dmcc 自己两次也不一致。**CSS 工具链差异已归零**(见下)。
- **源码分发 = OPFS 单写多读,零 postMessage 克隆**(2026-07-02 六):主线程 `writeSourceToOpfs(token, files)` 写一次,只传 token;coordinator 转发 token;各 stage worker `readSourceFromOpfs(token)` 独立 hydrate 进私有 memfs。源码克隆 4→0(旧 main→coord→3worker;weui 2.9M)。`demo/opfs-source.js` + `npm run test:opfs`。
- **CSS 工具链对齐**(2026-07-02 六):浏览器版曾把 `autoprefixer`/`cssnano` no-op(页面 wxss 不压缩/无前缀),现打包真实实现(与 dmcc 同版 cssnano 8.0.2);**autoprefixer pin 到 node/dmcc 运行时解析的同一份 10.5.0**(避开 esbuild 打包器解析到另一 pnpm island 的 10.5.2 对 ie11 多加 `-ms-`);esbuild-wasm 对齐 0.28.1。只需 `process.env+cwd` 极小 shim(不加 `versions.node`)。代价:bundle 8.2M→11.3M(caniuse-lite 数据)。
- **常驻 worker:已实现并验证**。工具链只 load 一次,冷 843ms→热 279ms(base 3.0×);复用时每次编译前 `resetCompilerState`(去掉即结构损坏,已证必要)。
- 主线架构:`OPFS 源码层 → hydrate 到 InMemory/memfs → 编译 → 常驻 worker(摊 wasm) [+ 可选 stage 级并行 via coordinator worker]`。dmcc node 端只有 stage 级并行(view 单 worker 串所有页),我们的 web 版并行粒度与它一致、且产物等价。

## 基准数据

单线程编译 `base` 示例(191 个源文件 → 86 个产物)。

### 浏览器(headless Chromium,crossOriginIsolated,真 wasm 工具链)

| fs 后端 | 编译耗时 | 相对 InMemory |
| --- | --- | --- |
| ZenFS **InMemory** | **367ms** | 1× |
| ZenFS **SingleBuffer**(over SharedArrayBuffer) | **12487ms** | **慢 34×** |
| OPFS hydrate 往返(写 120ms + 读 76ms) | 读 76ms 灌进 InMemory | — |

浏览器 InMemory(367ms)≈ Node InMemory(346ms):**wasm 工具链(热身后)不是瓶颈,fs 才是**。

### 大项目 & 内容体量(浏览器,单线程 InMemory,热)

| 项目 | 文件数 | 编译耗时 | 冷启动(含工具链) | 常驻热编译 |
| --- | --- | --- | --- | --- |
| base | 191(小文件) | 367ms | 843ms | **279ms(冷/热 3.0×)** |
| vant | 542(小文件) | 878ms | — | — |
| genshin | 37(Taro 大 bundle) | 2643ms | 3615ms | 2894ms(1.2×) |

**编译耗时由内容体量驱动,不是文件数**:genshin 才 37 个文件却最慢(大 bundle 转换量大)。近似线性:base→vant 文件数 2.8× → 耗时 2.4×。

### stage 分解(浏览器,热)——决定"要不要多 worker"

| 项目 | logic | view | style | setup+collect | 总计 | view 占比 |
| --- | --- | --- | --- | --- | --- | --- |
| base | 138ms | 152ms | 52ms | 18ms | 359ms | 42% |
| vant | 183ms | 559ms | 49ms | 149ms | 941ms | 59% |
| **genshin** | 219ms | **2521ms** | 14ms | 12ms | 2765ms | **91%** |

**长木板是 view,且越重的项目越极端(genshin 91%)**。stage 级并行墙钟 = max(stage) = view 时间 → genshin 只省 ~9%,不值。→ 有效的并行是 **view 内部按页拆**(下节)。

### 页级并行 + 常驻 worker 池(4 worker,浏览器)

view 随页数近似线性(genshin 1页283ms/2页697/4页1191/8页2464),每页写独立 `main/{page}.js` → 可按页分给常驻 worker 池、输出取并集。

| 项目 | 页数 | 单线程热 | 并行冷 | 并行热 | 加速 | == 单线程 |
| --- | --- | --- | --- | --- | --- | --- |
| base | 39 | 581ms | 852ms | 195ms | 3.0× | ✅ |
| genshin | 8 | 2814ms | 1759ms | 921ms | 3.06× | ✅ |
| vant | 13 | 1012ms | 1098ms | 367ms | 2.8× | ❌ |

常驻池下并行冷(1759)都 < 单线程热(2814):N 个 worker 的 wasm 工具链并行加载,冷代价只付一份。**正确性边界**:vant 发散——view 编译器 app 级全局模块去重(共享组件/wxs 全 app 只产一次,靠运行时全局 modDefine 跨页共享),页级拆到独立 realm 无法协调放置,合并缺/重模块。genshin/base 页间共享少所以正确。实现:web-client `demo/parallel-test.html` + `compiler.worker.js` 的 `compile-subset`,`npm run test:parallel`。

### Node(原生 esbuild/oxc,同项目)

| fs 后端 | 编译耗时 | 相对 memfs |
| --- | --- | --- |
| memfs | 384ms | 1× |
| ZenFS InMemory | 346ms | 0.9×(与 memfs 同级,可弃 memfs) |
| ZenFS SingleBuffer(over ArrayBuffer) | 3022ms | 慢 7.9× |

> SingleBuffer 在浏览器比 Node 更慢(34× vs 7.9×):SharedArrayBuffer + Atomics 比普通 ArrayBuffer 慢,把 O(n) 读放大。**Node 数字会严重低估真实代价——性能结论以浏览器为准。**

复现:`node --import ./scripts/register-kit.js scripts/bench-fs.js`(Node);web-client `demo/bench.worker.js` + `scripts/run-bench.mjs`(浏览器)。

## 关键发现(按主题)

1. **编译器可拆解为并行接缝**。`compileMiniApp` 拆成 `setupCompile`(一次性 config/dist/npm)+ `compileStage('logic'|'view'|'style', …)` + `collectOutputs` + `resetCompilerState`(清模块级缓存以复用 realm)。三 stage 产物**不相交**(logic 只 `.js` / view 只 view 脚本 / style 只 `.css`),编译期互不回读对方产物 → 可并发。见 `src/compile-core.js`、`scripts/test-decompose.js`。

2. **ZenFS SingleBuffer 对齐 bug(上游 #224 回归)**。`rotateMetadata()` 把向上对齐补齐量算成了余数本身(`used_bytes % 4`,应为 `(4-rem)%4`),元数据块满 255 条换块时、`used_bytes%4∈{1,3}` 必崩(`RangeError: start offset of Int32Array should be a multiple of 4`)。任何真实项目文件数都过 255,单线程即触发。已 `pnpm patch` 固化(`patches/@zenfs__core@2.5.7.patch`),Codex + 运行时双验证。**值得给 zen-fs/core 报"回归"**(2.2.2 修过,2.5.x 又回来了)。

3. **并发写共享 SingleBuffer 会损坏元数据 → 官方不支持**。3 个 worker 并发写同一 SAB 时,一个 worker 刚建的 inode 被另一个的并发元数据写冲掉,关句柄时 `ENOENT`(create-race:找空槽在锁外)。zen-fs #210 明确:"there is no built-in concurrent access prevention"。→ 架构定为 **worker 只读共享、写私有层、主进程合并**(overlay,即 #204 里 `CopyOnWrite` readable=SingleBuffer + writable=私有 的官方版)。见 `scripts/parallel/overlay-fs.js`、`scripts/test-parallel.js`。该 overlay 版并发编译产物与单线程**逐字节一致**。

4. **SingleBuffer 慢在 O(n) 线性扫元数据链读**(`get(id)` 遍历 metadata block + entry),读密集的编译被放大成 O(n²)。这是"共享 SAB 直接当编译 fs"不可行的根因——**不是"共享"概念错,是这个后端的读实现慢**。

5. **hydrate 便宜、InMemory 快**。从 OPFS 读全部源码进 InMemory 仅 76ms;之后编译走 InMemory(367ms)。所以"贵的共享层 + 快的编译层"分离是对的。

## 架构决策

```
  源码真相源                     hydrate(便宜)          快 fs
┌──────────────┐   read 76ms   ┌──────────────┐   367ms  ┌─────────┐
│ OPFS (推荐)   │ ────────────► │ ZenFS InMemory│ ───────► │ 编译产物 │
│  或 SAB       │               │  (编译在此)   │          └─────────┘
└──────────────┘               └──────────────┘
       ▲
   editor 写这里
```

- **编译层永远是 `InMemory`**;真相源层可换(OPFS / SAB)。二者解耦,靠 hydrate 连接。
- **OPFS 作真相源优于 SAB**:持久(刷新不丢)、免 COOP/COEP、hydrate 便宜、无 2GB 上限。SAB 的零拷贝优势在"反正要 hydrate"下用不上。
- **editor ↔ 编译器共享源码**:editor 写 OPFS,编译器 hydrate。共享达成且更简单、持久。
- **web-compiler 仍不持有 fs**:`compileMiniApp({ fs })` 由下游注入 `InMemory` 实例;真相源/hydrate 全在下游。

## 待办 / 开放问题

- [x] OPFS → InMemory 的 hydrate 适配封装(下游)。**已实现**:`demo/opfs-source.js`(write/read),coordinator 只传 token、各 worker 独立 hydrate,源码零 postMessage 克隆(`npm run test:opfs`)。产物写回 OPFS 的增量策略仍开放。
- [x] wasm↔native 工具链对齐(缩小 web↔node 差)。**已完成**:根因是浏览器版 no-op 了 cssnano/autoprefixer + autoprefixer pnpm island 版本差(10.5.2 vs node 10.5.0);打包真实 CSS 管线 + pin autoprefixer + 升 esbuild-wasm 0.28.1 后 `realToolchainDiffs: 0`,structHash 与 dmcc 三者同一。剩余差纯属编译器固有随机 id(非工具链)。
- [x] 常驻 worker:load 一次 wasm 工具链,后续编译复用。**已实现并验证**(web-client `demo/compiler.worker.js` + `demo/resident-test.html`):冷 843ms→热 279ms(base 3.0×);reset 经"去掉即结构损坏"证明必要。
- [ ] 增量重编译:改一页只重编该单元(编译期不回读产物已证可行);注意改共享组件需重跑 logic 的反向注入。**重项目(genshin view 91%)的下一杆就是它,不是并行**。
- [x] 大项目并行是否回本——**已测,不回本**:genshin 2.6s 里 view 占 91%,stage 并行只省 ~9%。多 worker 搁置。
- [ ] 给 zen-fs/core 报 #224 对齐 bug 回归。
- [ ] OPFS `createSyncAccessHandle` 独占锁 / editor 与编译并发写同文件的协调(若做实时共享)。

## Changelog

- **2026-07-02**:首版。记录 Node + 浏览器 fs 后端基准、SingleBuffer 对齐 bug + patch、并发写损坏 + overlay 方案、以及"OPFS+InMemory+hydrate"主线决策。并行(overlay 版)在 Node 验证产物正确但小项目净亏。
- **2026-07-02(二)**:大项目基准(vant 542 文件 878ms / genshin 37 大 bundle 2643ms)+ stage 分解(genshin view 占 91%)→ **stage 级并行不做**。常驻 worker 实现并浏览器验证(冷 843ms→热 279ms,base 3.0×;reset 经去除即损坏证明必要)。发现编译产物本非字节确定(scoped id + esbuild 变量命名),正确性判据改为"结构等价:同 key 集 + 同长度"。下游用法写入 web-client README。
- **2026-07-02(四)**:方案收敛为 **stage 级并行(与 dmcc 一致)+ coordinator worker**。放弃页级(破坏 app 级全局模块去重,vant 发散;`modDefine` 幂等已核实)。三常驻 worker 各跑一 stage,coordinator worker(嵌套)派发+合并、主线程编译最大卡顿 2ms。`test:compare`(taro-todo/weui/vant)证明 stage-并行 structHash 与单线程逐位相同(零发散),相对 dmcc 接近度与单线程一字不差。逐字节与 dmcc 一致不可能(dmcc 自身 base 仅 11/86 逐字节同)。web↔node 残余差 = wasm vs native 工具链。base 4.78×/vant 2.1×/genshin 1.1×。
- **2026-07-02(六)**:**OPFS 源分发 + 工具链对齐,两遗留清零**。① OPFS 单写多读(`demo/opfs-source.js`,主线程写一次+传 token,各 worker `readSourceFromOpfs` 独立 hydrate),源码 postMessage 克隆 4→0,主线程卡顿 3ms(`test:opfs`)。② `diff-web-node` 逐文件比对定位 web↔node 差:CSS 根因=浏览器版 no-op 了 cssnano/autoprefixer;JS 差全是 delta=0 随机 id(node 自己两次也不一致)。修法:打包真实 cssnano+autoprefixer(process 加 cwd、os 加 homedir、define 注入 __filename;**不加 process.versions.node**),autoprefixer **pin 到 node 运行时解析的 10.5.0**(esbuild 打包器本会解析到 dimina fe pnpm 的 10.5.2,对 ie11 多加 -ms-),esbuild-wasm 升 0.28.1。内联 CSS 库到 **node** 构建是错路(browserslist config 查找走进注入的 memfs 崩)→ node 保持 external,只对齐运行时解析的那份。结果:`test:compare` structHash node=single=stage 三者同一、`stage vs node` 495/495;`diff-web-node` 四项目 `realToolchainDiffs: 0`。**CSS 工具链归零、web 与 dmcc 结构逐字节一致**。代价 bundle 8.2→11.3M。README 加 OPFS 架构图 + mermaid 端到端流程图。
- **2026-07-02(三)**:实现**页级并行 + 常驻 worker 池**(`compile-subset` 消息按页分区 view + logic/style 放 worker 0 + 输出并集)。4 worker 实测 genshin 3.06×/base 3.0×,常驻池冷启动都快过单线程热。**但发现正确性边界**:view 编译器 app 级全局模块去重使 vant 类组件库应用页级并行后产物发散(缺/重共享模块)。→ 页级并行只对页面独立应用安全;通用化需编译器支持"每页自包含"或"公共 bundle"。
