/**
 * wxml/lsp — monaco language providers for `wxml`.
 *
 * **不是**完整 LSP。我们直接用 monaco 内置 provider API + 手写元数据
 * （见 ./wxml-data.ts），覆盖：
 *   - completion: 标签名（`<vi` → `view`）、属性名（`<button ` → `type`、`bindtap`…）、
 *     属性值枚举（`type="` → `primary`、`default`、`warn`）、wx: 指令、bindxxx/catchxxx 事件
 *   - hover: 在标签名 / 属性名上停留时显示一段描述
 *
 * 不提供：formatting、diagnostics、jump-to-definition、rename。
 *
 * 替代路线（如果将来要升级到 vscode-html-languageservice + 注入自定义 data）：
 *   - `_spike/opensumi-lite/package.json` 添加 vscode-html-languageservice@^3.x，
 *   - 用 `getLanguageService({customDataProviders: [wxmlDataProvider]})` 替换本文件，
 *   - 通过 `htmlLanguageService.doComplete()/doHover()` 拿 LSP 标准结果再桥接到 monaco。
 *   本文件保持了相同的导出 API（`registerWxmlLanguageProviders()`），切换时只改这里。
 */

import * as monaco from 'monaco-editor';
import {
  WXML_TAGS,
  WXML_DIRECTIVES,
  WXML_GLOBAL_ATTRS,
  TAG_MAP,
  buildEventAttrs,
  WxmlAttr,
  WxmlTag,
} from './wxml-data';

type CompletionItem = monaco.languages.CompletionItem;

// monaco.languages.CompletionItemKind enum values (硬编码避免 enum import
// 在 webpack 4 + ts-loader transpileOnly 模式下被错误丢弃):
//   Class = 6, Property = 9, EnumMember = 19 (monaco 与 vscode-types 一致)
const KIND_CLASS = 6;
const KIND_PROPERTY = 9;
const KIND_ENUM_MEMBER = 19;
const SNIPPET = 4; // monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet

const EVENT_ATTRS = buildEventAttrs();

/** 文本范围工厂 — monaco range 需要 (startLine, startCol, endLine, endCol)。 */
function rangeAt(position: monaco.Position, length: number): monaco.IRange {
  return {
    startLineNumber: position.lineNumber,
    startColumn: Math.max(1, position.column - length),
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  };
}

/**
 * 探测光标当前所处的上下文：
 *   - 'tag': `<vi` / `<` 之后还没空格，正在敲标签名
 *   - 'attr-name': 标签内空白处，正在敲属性名
 *   - 'attr-value': 在 `="..."` 引号内，正在敲属性值
 *   - 'text': 标签外，纯文本/插值；不参与补全
 *
 * 算法：从光标位置往左扫到最近一个 `<` 或 `>`。
 *   遇到 `>` → 标签外。
 *   遇到 `<` → 标签内：再看光标到 `<` 之间是否含空格 — 含 = 属性区，否则 = 标签名。
 *   若属性区，看光标紧邻是否在 `"..."` 内（统计 `=` 后引号配对）。
 */
interface WxmlContext {
  kind: 'tag' | 'attr-name' | 'attr-value' | 'text';
  /** 当前所在标签名（标签区/属性区时有效）。 */
  tagName?: string;
  /** 属性值上下文时，对应的属性名。 */
  attrName?: string;
  /** 当前正在敲的"词"前缀（标签名前缀 / 属性名前缀），用于替换 range 计算。 */
  prefix: string;
}

function detectContext(model: monaco.editor.ITextModel, position: monaco.Position): WxmlContext {
  const lineText = model.getLineContent(position.lineNumber);
  const col = position.column - 1; // monaco column 1-based; turn into 0-based slice index

  // 从光标向左扫，跨行 cheap fallback：先看本行，找不到 `<` 再合并上一行（最多一行避免无界）
  let buf = lineText.slice(0, col);
  if (!buf.includes('<')) {
    if (position.lineNumber > 1) {
      const prev = model.getLineContent(position.lineNumber - 1);
      buf = prev + '\n' + buf;
    }
  }
  const lastLt = buf.lastIndexOf('<');
  const lastGt = buf.lastIndexOf('>');

  if (lastLt < 0 || lastLt < lastGt) {
    return { kind: 'text', prefix: '' };
  }

  // 取 `<` 之后到光标的所有字符
  const inTag = buf.slice(lastLt + 1);

  // 标签名 = `<` 之后到第一个空白/引号/`>` 之前
  const tagMatch = /^([a-zA-Z][\w-]*)/.exec(inTag);
  const tagName = tagMatch ? tagMatch[1] : '';

  // 判断"光标在标签名上"：inTag 里**没**空白
  if (!/\s/.test(inTag)) {
    return { kind: 'tag', tagName, prefix: inTag };
  }

  // 进入属性区。看是否在引号里
  const afterTag = inTag.slice(tagName.length);
  // 统计未配对的引号
  let inQuote: '"' | "'" | null = null;
  let attrTokenStart = -1;
  for (let i = 0; i < afterTag.length; i++) {
    const ch = afterTag[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch as '"' | "'";
      continue;
    }
    if (/\s/.test(ch)) {
      attrTokenStart = -1;
      continue;
    }
    if (ch === '=') {
      continue;
    }
    if (attrTokenStart < 0) attrTokenStart = i;
  }

  if (inQuote) {
    // attr-value 上下文。找最近 attr-name=
    // 从光标往左找 = 之前的标识符
    const m = /([\w:-]+)\s*=\s*["'][^"']*$/.exec(afterTag);
    return {
      kind: 'attr-value',
      tagName,
      attrName: m ? m[1] : undefined,
      // 引号内已敲字符
      prefix: /["']([^"']*)$/.exec(afterTag)?.[1] ?? '',
    };
  }

  // attr-name 上下文。prefix = 当前正在敲的属性名前缀
  const namePrefix = /([\w:-]*)$/.exec(afterTag)?.[1] ?? '';
  return { kind: 'attr-name', tagName, prefix: namePrefix };
}

function tagCompletion(tag: WxmlTag, position: monaco.Position, prefix: string): CompletionItem {
  const range = rangeAt(position, prefix.length);
  return {
    label: tag.name,
    kind: KIND_CLASS,
    insertText: tag.name,
    detail: '微信小程序组件',
    documentation: { value: tag.description },
    range,
  } as CompletionItem;
}

function attrCompletion(attr: WxmlAttr, position: monaco.Position, prefix: string): CompletionItem {
  const range = rangeAt(position, prefix.length);
  const snippet = `${attr.name}="$0"`;
  return {
    label: attr.name + (attr.required ? '*' : ''),
    kind: KIND_PROPERTY,
    insertText: snippet,
    insertTextRules: SNIPPET,
    detail: attr.required ? '必填' : undefined,
    documentation: attr.description ? { value: attr.description } : undefined,
    range,
  } as CompletionItem;
}

function attrValueCompletion(value: string, position: monaco.Position, prefix: string): CompletionItem {
  const range = rangeAt(position, prefix.length);
  return {
    label: value,
    kind: KIND_ENUM_MEMBER,
    insertText: value,
    range,
  } as CompletionItem;
}

/**
 * 计算给定标签的全部可补全属性 = 标签专属属性 + 通用 + 指令 + 事件。
 */
function collectAttrsForTag(tagName: string | undefined): WxmlAttr[] {
  const out: WxmlAttr[] = [];
  if (tagName) {
    const tag = TAG_MAP.get(tagName);
    if (tag?.attrs) out.push(...tag.attrs);
  }
  // 通用属性 + 指令 + 事件
  out.push(...WXML_GLOBAL_ATTRS);
  out.push(...WXML_DIRECTIVES);
  out.push(...EVENT_ATTRS);
  return out;
}

function makeCompletionProvider(): monaco.languages.CompletionItemProvider {
  return {
    triggerCharacters: ['<', ' ', ':', '"'],

    provideCompletionItems: (model, position) => {
      const ctx = detectContext(model, position);

      if (ctx.kind === 'text') {
        return { suggestions: [] };
      }

      if (ctx.kind === 'tag') {
        const suggestions = WXML_TAGS
          .filter((t) => !ctx.prefix || t.name.startsWith(ctx.prefix))
          .map((t) => tagCompletion(t, position, ctx.prefix));
        return { suggestions };
      }

      if (ctx.kind === 'attr-name') {
        const all = collectAttrsForTag(ctx.tagName);
        const seen = new Set<string>();
        const suggestions = all
          .filter((a) => {
            if (seen.has(a.name)) return false;
            seen.add(a.name);
            return !ctx.prefix || a.name.startsWith(ctx.prefix);
          })
          .map((a) => attrCompletion(a, position, ctx.prefix));
        return { suggestions };
      }

      // attr-value
      if (ctx.kind === 'attr-value' && ctx.tagName && ctx.attrName) {
        const tag = TAG_MAP.get(ctx.tagName);
        const attr = tag?.attrs?.find((a) => a.name === ctx.attrName);
        if (attr?.values && attr.values.length) {
          const suggestions = attr.values
            .filter((v) => !ctx.prefix || v.startsWith(ctx.prefix))
            .map((v) => attrValueCompletion(v, position, ctx.prefix));
          return { suggestions };
        }
      }
      return { suggestions: [] };
    },
  };
}

function makeHoverProvider(): monaco.languages.HoverProvider {
  return {
    provideHover: (model, position) => {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const token = word.word;

      // 检测当前是标签上下文还是属性上下文：往左找最近一个 `<`，看 word 后是否有空白
      const lineText = model.getLineContent(position.lineNumber);
      const before = lineText.slice(0, word.startColumn - 1);
      const ltIdx = before.lastIndexOf('<');
      const gtIdx = before.lastIndexOf('>');
      if (ltIdx < 0 || ltIdx < gtIdx) return null;
      const inTag = before.slice(ltIdx + 1);
      const isTagPos = !/\s/.test(inTag);

      if (isTagPos) {
        const tag = TAG_MAP.get(token);
        if (!tag) return null;
        return {
          range: {
            startLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endLineNumber: position.lineNumber,
            endColumn: word.endColumn,
          },
          contents: [
            { value: `**<${tag.name}>** — 微信小程序组件` },
            { value: tag.description },
          ],
        };
      }

      // 属性 hover
      // 优先匹配指令/事件，再匹配标签专属
      const matchInList = (list: WxmlAttr[]): WxmlAttr | undefined =>
        list.find((a) => a.name === token);
      const fromDir = matchInList(WXML_DIRECTIVES);
      const fromGlobal = matchInList(WXML_GLOBAL_ATTRS);
      const fromEvent = matchInList(EVENT_ATTRS);
      // 当前标签
      const tagMatch = /^([a-zA-Z][\w-]*)/.exec(inTag);
      const tagName = tagMatch ? tagMatch[1] : '';
      const fromTagAttr = tagName ? matchInList(TAG_MAP.get(tagName)?.attrs ?? []) : undefined;
      const attr = fromTagAttr || fromDir || fromGlobal || fromEvent;
      if (!attr) return null;
      return {
        range: {
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: word.endColumn,
        },
        contents: [
          { value: `**${attr.name}**${attr.required ? ' (必填)' : ''}` },
          ...(attr.description ? [{ value: attr.description }] : []),
          ...(attr.values ? [{ value: '可选值：`' + attr.values.join('`, `') + '`' }] : []),
        ],
      };
    },
  };
}

/**
 * Idempotent — 多次调用只注册一次。disposable 通过 module-level 缓存持有，
 * 防止 hot-reload 累积 provider。
 */
let registered = false;
let disposables: monaco.IDisposable[] = [];

export function registerWxmlLanguageProviders(): void {
  if (registered) return;
  registered = true;
  try {
    const completionProvider = makeCompletionProvider();
    const hoverProvider = makeHoverProvider();
    disposables.push(
      monaco.languages.registerCompletionItemProvider('wxml', completionProvider),
    );
    disposables.push(
      monaco.languages.registerHoverProvider('wxml', hoverProvider),
    );

    // 测试钩子：暴露 provider 实例，spec 可直接调 provideCompletionItems /
    // provideHover，避免依赖 monaco 私有 registry 或 suggest widget 时序。
    // 命名空间 `__dimina*`，生产代码不读它。仅非生产构建暴露：生产 renderer
    // 不携带 `__dimina*` 测试钩子（e2e 断言主窗口主世界零 `__dimina*` 泄漏）。
    if (process.env.NODE_ENV !== 'production') {
      try {
        (window as unknown as { __diminaWxmlProviders?: unknown }).__diminaWxmlProviders = {
          completion: completionProvider,
          hover: hoverProvider,
        };
      } catch { /* non-browser env */ }
    }

    console.log('[dimina-grammar] wxml LSP providers registered (completion + hover)');
  } catch (err) {
    console.warn('[dimina-grammar] wxml provider registration failed:', (err as Error)?.message ?? err);
  }
}

export function disposeWxmlLanguageProviders(): void {
  for (const d of disposables) {
    try { d.dispose(); } catch { /* ignore */ }
  }
  disposables = [];
  registered = false;
}
