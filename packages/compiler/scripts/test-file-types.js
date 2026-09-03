// src/file-types.js 把编译器的合并规则抄了一份出来（env.js 直接 import 会拉进 node:fs 和
// 整个配置解析，宿主只想知道扩展名）。抄来的东西会漂：所以这里直接读 env.js 源码，比对内置
// 列表、保留扩展名和两条规范化正则——上游加一种内置方言或改一条正则，这个测试就红，而不是
// 等某个宿主把文件分错类。后半段是合并行为本身。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  BUILTIN_STYLE_EXTS,
  BUILTIN_TEMPLATE_DIRECTIVE_PREFIXES,
  BUILTIN_TEMPLATE_EXTS,
  BUILTIN_VIEW_SCRIPT_EXTS,
  BUILTIN_VIEW_SCRIPT_TAGS,
  QD_FILE_TYPES,
  RESERVED_EXTS,
  hasExt,
  resolveFileTypes,
} from '../src/file-types.js'

let failed = 0
const chk = (cond, msg) => { if (cond) { console.log(`✅ ${msg}`) } else { console.log(`❌ ${msg}`); failed++ } }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const ENV_PATH = fileURLToPath(new URL('../../../dimina/fe/packages/compiler/src/env.js', import.meta.url))
const env = readFileSync(ENV_PATH, 'utf8')

const listOf = (name) => {
  const m = env.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))
  if (!m) throw new Error(`${name} 不在 ${ENV_PATH} 里了——编译器改了内置文件类型的写法，先看它现在怎么写`)
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1])
}
const regexOf = (fnName) => {
  const start = env.indexOf(`function ${fnName}(`)
  if (start < 0) throw new Error(`${fnName} 不在 ${ENV_PATH} 里了——先看编译器现在怎么校验扩展名`)
  const m = env.slice(start).match(/!(\/\S+?\/)\.test\(v\)/)
  if (!m) throw new Error(`${fnName} 里的规范化正则找不到了——先看编译器现在怎么校验扩展名`)
  return m[1]
}

chk(same([...BUILTIN_TEMPLATE_EXTS], listOf('DEFAULT_TEMPLATE_EXTS')),
  `内置模板扩展名与编译器一致（${BUILTIN_TEMPLATE_EXTS.join(' ')}）`)
chk(same([...BUILTIN_TEMPLATE_DIRECTIVE_PREFIXES], listOf('DEFAULT_TEMPLATE_DIRECTIVE_PREFIXES')),
  `内置模板指令前缀与编译器一致（${BUILTIN_TEMPLATE_DIRECTIVE_PREFIXES.join(' ')}）`)
chk(same([...BUILTIN_STYLE_EXTS], listOf('DEFAULT_STYLE_EXTS')),
  `内置样式扩展名与编译器一致（${BUILTIN_STYLE_EXTS.join(' ')}）`)
chk(same([...BUILTIN_VIEW_SCRIPT_EXTS], listOf('DEFAULT_VIEW_SCRIPT_EXTS')),
  `内置视图脚本扩展名与编译器一致（${BUILTIN_VIEW_SCRIPT_EXTS.join(' ')}）`)
chk(same([...BUILTIN_VIEW_SCRIPT_TAGS], listOf('DEFAULT_VIEW_SCRIPT_TAGS')),
  `内置视图脚本标签与编译器一致（${BUILTIN_VIEW_SCRIPT_TAGS.join(' ')}）`)

{
  const block = env.slice(env.indexOf('const RESERVED_EXTS = new Set(['))
  const extra = [...block.slice(0, block.indexOf('])')).matchAll(/'([^']*)'/g)].map((x) => x[1])
  chk(same(RESERVED_EXTS.filter((e) => !BUILTIN_TEMPLATE_EXTS.includes(e) && !BUILTIN_STYLE_EXTS.includes(e) && !BUILTIN_VIEW_SCRIPT_EXTS.includes(e)), extra),
    `保留扩展名里非内置的那几个与编译器一致（${extra.join(' ')}）`)
}

chk(regexOf('normalizeExt') === '/^[a-z0-9_-]+$/', `扩展名校验正则与编译器一致（${regexOf('normalizeExt')}）`)
chk(regexOf('normalizeTag') === '/^[a-z][a-z0-9_-]*$/', `标签名校验正则与编译器一致（${regexOf('normalizeTag')}）`)

// 合并行为
{
  const r = resolveFileTypes(QD_FILE_TYPES)
  chk(same(r.templateExts, ['.wxml', '.ddml', '.qdml']), `qd 方言的模板扩展名（${r.templateExts.join(' ')}）`)
  chk(same(r.styleExts, ['.wxss', '.ddss', '.less', '.scss', '.sass', '.qdss']), `qd 方言的样式扩展名（${r.styleExts.join(' ')}）`)
  chk(same(r.viewScriptExts, ['.wxs', '.qds']), `qd 方言的视图脚本扩展名（${r.viewScriptExts.join(' ')}）`)
  chk(same(r.viewScriptTags, ['wxs', 'dds', 'qds']), `视图脚本扩展名同时派生内联标签（${r.viewScriptTags.join(' ')}）`)
  chk(r.templateDirectivePrefixes.includes('qd'), `自定义模板扩展名派生出指令前缀（${r.templateDirectivePrefixes.join(' ')}）`)
}

{
  const r = resolveFileTypes()
  chk(same(r.templateExts, [...BUILTIN_TEMPLATE_EXTS]), '不传 fileTypes 就只有内置项')
  r.templateExts.push('.mine')
  chk(!BUILTIN_TEMPLATE_EXTS.includes('.mine'), '返回的是副本，改它不会污染内置列表')
}

chk(same(resolveFileTypes({ template: ['js', 'ts', 'json', 'wxss'] }).templateExts, ['.wxml', '.ddml']),
  '占用逻辑/配置/其他角色扩展名的自定义项被丢弃')
chk(same(resolveFileTypes({ template: ['.QDML', 'qdml', '  qdml  '] }).templateExts, ['.wxml', '.ddml', '.qdml']),
  '带点、大写、带空白的写法规范化成同一项，且只留一份')
chk(same(resolveFileTypes({ template: ['a/b', 'q*d', '', '   '] }).templateExts, ['.wxml', '.ddml']),
  '带路径分隔符或元字符的项被丢弃')
chk(same(resolveFileTypes({ viewScript: ['9qd'] }).viewScriptTags, ['wxs', 'dds']),
  '数字开头不能当标签名（扩展名可以，标签名不行）')
chk(same(resolveFileTypes({ viewScript: ['9qd'] }).viewScriptExts, ['.wxs', '.9qd']),
  '同一项作为扩展名仍然有效')

chk(hasExt('pages/index/index.QDML', resolveFileTypes(QD_FILE_TYPES).templateExts), 'hasExt 大小写不敏感')
chk(!hasExt('pages/index/index.json', resolveFileTypes(QD_FILE_TYPES).templateExts), 'hasExt 不误判 .json')
chk(!hasExt(undefined, BUILTIN_TEMPLATE_EXTS), 'hasExt 对非字符串返回 false')

console.log(failed ? `\n❌ ${failed} 条文件类型断言失败。` : '\n✅ 方言常量与编译器的合并规则一致。')
process.exit(failed ? 1 : 0)
