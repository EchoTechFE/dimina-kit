# pawl 质量门禁

本目录保存 dimina-kit 对 [pawl](https://github.com/tiangong-dev/pawl) 的项目配置和自定义指标适配器。pawl 会把每个质量指标记录到 `pawl.snapshot.json`，以后只要某项变差，`pawl check` 就返回失败。

它是仓库工具，不是可发布的 npm 包。CLI 由根 `package.json` 中的 `@pawl-tools/cli` 提供，指标配置在根目录的 `pawl.yaml`。

## 常用命令

在仓库根目录运行：

```bash
pnpm pawl:check          # 重新测量并与快照比较；退化时退出 1
pnpm pawl:diff           # 显示差异，但不因退化而失败
pnpm pawl:record         # 用当前测量结果重写 pawl.snapshot.json
pnpm exec pawl guard <git-ref>
                         # 比较当前快照与指定 git ref 中的快照
```

只有在确认改进来自真实代码变化后才运行 `pawl:record`。缺少报告、适配器崩溃或输出无法解析时，结果是“无法测量”，不应记录成新的基线。

## 当前指标

下表直接对应 `pawl.yaml`：

| ID | 测量内容 | 趋势 | 比较方式 |
| --- | --- | --- | --- |
| `file-length` | 超过 500 行的包内 `.ts`、`.tsx` 源文件数 | 越低越好 | 总数 |
| `type-escapes` | `any` 和 `@ts-*` 抑制 | 越低越好 | 每个文件的数量 |
| `cognitive-complexity` | 认知复杂度超过 15 的函数 | 越低越好 | 每个文件的数量 |
| `code-duplication` | jscpd 发现的重复代码行 | 越低越好 | 总数 |
| `circular-deps` | 单个包内生产源码的循环依赖 | 越低越好 | 总数 |
| `type-coverage` | 各包非 `any` 标识符占比 | 越高越好 | 每个键的值 |
| `test-coverage` | 各测试套件覆盖的源代码行比例 | 越高越好 | 每个键的值，允许 1 个百分点波动 |
| `test-report` | Vitest JSON 报告中真正通过的测试数 | 越高越好 | 每个键的值 |

`file-length`、`type-escapes` 和 `cognitive-complexity` 使用 pawl 内置能力。其余项目特有的汇总由 `tools/pawl/adapters/*.ts` 计算，再经 `pawl-adapter.ts` 输出 pawl 读取的 JSON。

## 运行前准备

`test-report` 和 `test-coverage` 不会主动运行测试。它们读取各包 `test` 脚本生成的 `test-report*.json` 与 `coverage-summary.json`。本地检查前应先运行与 CI 相同的测试任务；报告不存在时，适配器会失败，而不是把结果当作 0。

这组 TypeScript 文件由 Node 的原生类型擦除直接执行，没有 `tsx` 或 `ts-node`。因此只使用可擦除的 TypeScript 语法，本地 import 也必须带 `.ts` 或 `.js` 扩展名。单独检查这个目录可运行：

```bash
pnpm exec tsc -p tools/pawl
```

## 添加项目指标

先确认 pawl 内置指标无法表达需求。确实需要自定义测量时：

1. 在 `tools/pawl/adapters/` 新建一个默认导出 `Adapter` 的文件。
2. 在 `pawl.yaml` 增加 `command: "node tools/pawl/pawl-adapter.ts <id>"`。
3. 为适配器补测试。
4. 运行测试和 `pnpm pawl:diff`，确认测量值正确后再运行 `pnpm pawl:record`。

```ts
import type { Adapter } from '../lib/types.ts'

const adapter: Adapter = {
  id: 'my-metric',
  title: 'My metric',
  direction: 'lower-is-better',
  async measure() {
    return {
      value: 42,
      unit: 'items',
      breakdown: { 'file.ts': 42 },
    }
  },
}

export default adapter
```

`pawl-adapter.ts` 会把缺省 `unit` 设成 `count`，把空的 `breakdown` 转成 `null`。加载失败、适配器形状错误和顶层异常返回退出码 2；`measure()` 自身抛错返回退出码 1。

## 相关文件

- [`../../pawl.yaml`](../../pawl.yaml)：指标、方向、比较方式和超时
- [`../../pawl.snapshot.json`](../../pawl.snapshot.json)：当前基线
- [`pawl-adapter.ts`](./pawl-adapter.ts)：自定义适配器入口
- [`adapters/`](./adapters)：项目特有测量
- [`eslint-gate.config.mjs`](./eslint-gate.config.mjs)：两项 ESLint 指标的独立配置
- [`lib/types.ts`](./lib/types.ts)：适配器类型
