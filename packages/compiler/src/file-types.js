/**
 * 自定义文件类型（方言）的权威声明，供宿主与编译器共用。
 *
 * 编译器认哪些扩展名，是 `options.fileTypes` 决定的（见 README「自定义文件类型」）。
 * 但宿主除了把这份配置传给编译器，自己也要按同一套规则判断文件角色——编辑器语言映射、
 * 模板校验、预览时找页面模板。它们各自手写 `/\.(wxml|qdml)$/` 这类正则时，漏掉内置的
 * `.ddml` 只是不显眼，真正的问题是同一个方言在几个仓库里各抄一份，谁改了另一边不会知道。
 *
 * 所以这里把两件事放在一处：内置扩展名与合并规则（`resolveFileTypes`），以及千岛（qd）
 * 方言这份具体配置（`QD_FILE_TYPES`）。宿主 import 它，而不是再抄一遍。
 *
 * 合并规则是照着编译器 `env.js` 的 `normalizeFileTypes` 写的（本包不能直接 import 它：
 * env.js 会拉进 node:fs 和整个配置解析）。`test:file-types` 直接读 env.js 源码比对内置
 * 列表和两条规范化正则，上游一改这里就红。
 *
 * 纯字符串处理、无依赖，任何运行时都能加载；同时发 ESM（dist/file-types.js）和
 * CJS（dist/file-types.cjs），因为 Electron 主进程那侧常常是 CommonJS。
 */

/** 内置模板扩展名。顺序即同名文件的查找优先级。 */
export const BUILTIN_TEMPLATE_EXTS = Object.freeze(['.wxml', '.ddml'])
/** 内置模板指令前缀（`wx:if` 的 `wx`）。自定义模板扩展名会再派生一个。 */
export const BUILTIN_TEMPLATE_DIRECTIVE_PREFIXES = Object.freeze(['wx', 'dd', 'a'])
/** 内置样式扩展名，含预处理器。 */
export const BUILTIN_STYLE_EXTS = Object.freeze(['.wxss', '.ddss', '.less', '.scss', '.sass'])
/** 内置视图脚本扩展名。 */
export const BUILTIN_VIEW_SCRIPT_EXTS = Object.freeze(['.wxs'])
/** 内置视图脚本内联标签（`<wxs module="m" />`）。 */
export const BUILTIN_VIEW_SCRIPT_TAGS = Object.freeze(['wxs', 'dds'])

/**
 * 自定义项不得占用的扩展名：所有内置角色 + 逻辑（.js/.ts）+ 配置（.json）。
 * 占用会导致跨角色串编——`template: ['js']` 会把页面逻辑当模板解析。
 */
export const RESERVED_EXTS = Object.freeze([
  ...BUILTIN_TEMPLATE_EXTS,
  ...BUILTIN_STYLE_EXTS,
  ...BUILTIN_VIEW_SCRIPT_EXTS,
  '.js',
  '.ts',
  '.json',
])

/**
 * 千岛（qd）方言：`.qdml`/`.qdss`/`.qds` 分别对应 `.wxml`/`.wxss`/`.wxs`。
 * 编译器、编辑器语言映射和宿主自己的文件分类都以这一份为准。
 * @type {Readonly<FileTypes>}
 */
export const QD_FILE_TYPES = Object.freeze({
  template: Object.freeze(['qdml']),
  style: Object.freeze(['qdss']),
  viewScript: Object.freeze(['qds']),
})

/**
 * 列表声明成只读：本包发出去的 `QD_FILE_TYPES` 是冻结的，写成可变数组的话，下游
 * 「再 push 一个扩展名」能通过类型检查，运行时才抛 TypeError。传入方向不受影响，
 * 普通数组照样能喂给 `resolveFileTypes`。
 *
 * @typedef {object} FileTypes
 * @property {readonly string[]} [template]    追加的模板扩展名，如 ['qdml']（点可带可不带）
 * @property {readonly string[]} [style]       追加的样式扩展名
 * @property {readonly string[]} [viewScript]  追加的视图脚本扩展名，同时派生同名内联标签
 */

/**
 * @typedef {object} ResolvedFileTypes
 * @property {string[]} templateExts                内置在前、自定义在后
 * @property {string[]} templateDirectivePrefixes   模板指令前缀
 * @property {string[]} styleExts
 * @property {string[]} viewScriptExts
 * @property {string[]} viewScriptTags              内联标签名（不带点）
 */

/**
 * 规范化成扩展名：去空白、转小写、补一个前导点。只接受字母、数字、连字符和下划线；
 * 空串、路径分隔符和其他元字符返回 null 由调用方丢弃——扩展名会用来拼尾部匹配正则。
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeExt(raw) {
  if (typeof raw !== 'string') return null
  const v = raw.trim().toLowerCase().replace(/^\.+/, '')
  if (!/^[a-z0-9_-]+$/.test(v)) return null
  return `.${v}`
}

/**
 * 规范化成内联标签名：同上但必须以字母开头且不带点——标签名会拼进选择器，
 * 放行元字符会让 `'qds,view'` 误选到 <view>。
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeTag(raw) {
  if (typeof raw !== 'string') return null
  const v = raw.trim().toLowerCase().replace(/^\.+/, '')
  if (!/^[a-z][a-z0-9_-]*$/.test(v)) return null
  return v
}

/**
 * @param {readonly string[]} builtins
 * @param {unknown} custom
 * @param {(raw: unknown) => string | null} normalizer
 * @param {Set<string>} [reserved]
 * @returns {string[]}
 */
function mergeUnique(builtins, custom, normalizer, reserved) {
  const out = [...builtins]
  const seen = new Set(out)
  if (Array.isArray(custom)) {
    for (const raw of custom) {
      const n = normalizer(raw)
      if (n && !seen.has(n) && !reserved?.has(n)) {
        seen.add(n)
        out.push(n)
      }
    }
  }
  return out
}

/**
 * 算出一次编译里编译器实际认的扩展名与标签——内置的加上这份 `fileTypes` 追加的。
 * 宿主用它做文件分类，就不会和编译器给出不同答案。
 * @param {FileTypes} [fileTypes]
 * @returns {ResolvedFileTypes}
 */
export function resolveFileTypes(fileTypes = {}) {
  const ft = fileTypes || {}
  const reserved = new Set(RESERVED_EXTS)
  const templateExts = mergeUnique(BUILTIN_TEMPLATE_EXTS, ft.template, normalizeExt, reserved)
  return {
    templateExts,
    templateDirectivePrefixes: [...new Set([
      ...BUILTIN_TEMPLATE_DIRECTIVE_PREFIXES,
      ...templateExts.map((extension) => {
        const name = extension.slice(1)
        return name.endsWith('ml') ? name.slice(0, -2) : name
      }).filter(Boolean),
    ])],
    styleExts: mergeUnique(BUILTIN_STYLE_EXTS, ft.style, normalizeExt, reserved),
    viewScriptExts: mergeUnique(BUILTIN_VIEW_SCRIPT_EXTS, ft.viewScript, normalizeExt, reserved),
    viewScriptTags: mergeUnique(BUILTIN_VIEW_SCRIPT_TAGS, ft.viewScript, normalizeTag),
  }
}

/**
 * 路径是不是这组扩展名之一。大小写不敏感，`resolveFileTypes` 的任一列表都能直接喂进来。
 * @param {string} filePath
 * @param {readonly string[]} exts
 * @returns {boolean}
 */
export function hasExt(filePath, exts) {
  if (typeof filePath !== 'string') return false
  const lower = filePath.toLowerCase()
  return exts.some((ext) => lower.endsWith(ext))
}
