/**
 * JSON Schemas + language wiring for dimina mini-program config files:
 *   - app.json            (global: pages / window / tabBar / subPackages / …)
 *   - page *.json          (per-page window overrides + usingComponents)
 *   - project.config.json  (tool/project settings)
 *
 * Field coverage is grounded in what the dimina compiler actually reads:
 *   - dimina/fe/packages/compiler/src/env.js storeAppConfig/storePageConfig:
 *     reads `pages`, `subPackages` (alias `subpackages`), `window`, `usingComponents`,
 *     page-level `usingComponents` / `component`.
 *   - dimina/fe/packages/compiler/src/core/config-compiler.js processTabBarIcons:
 *     reads `tabBar.list[].{pagePath,iconPath,selectedIconPath}` (+ text per examples).
 *   - example app.json files (dimina/fe/example/**\/app.json) for window keys,
 *     `permission`, `requiredPrivateInfos`, `networkTimeout`, `debug`.
 *   - project.config.json fields from the fixture + example projects
 *     (description / setting / compileType / libVersion / appid / condition /
 *     packOptions / editorSetting).
 *
 * Fields not provable from dimina source are still allowed (additionalProperties
 * stays open / index-style) rather than asserted as required, so valid-but-
 * undocumented keys are not flagged.
 *
 * Activation: the JSON language *server* extension is not part of this spike's
 * wiring, so schema IntelliSense is driven directly here via
 * vscode-json-languageservice (completion / hover / diagnostics providers),
 * mirroring how wxml-language.ts drives vscode-html-languageservice. No
 * marketplace JSON-language-features extension is required.
 */
import type * as vscode from 'vscode'
import {
  getLanguageService as getJsonLanguageService,
  TextDocument as JsonTextDocument,
  type LanguageService as JsonLanguageService,
  type JSONSchema,
} from 'vscode-json-languageservice'

/** Shared window block — used by app.json `window` and page-level *.json. */
const WINDOW_PROPERTIES: Record<string, JSONSchema> = {
  navigationBarBackgroundColor: { type: 'string', description: '导航栏背景颜色，如 #000000。', default: '#000000' },
  navigationBarTextStyle: { type: 'string', enum: ['black', 'white'], description: '导航栏标题颜色，仅 black / white。', default: 'white' },
  navigationBarTitleText: { type: 'string', description: '导航栏标题文字内容。' },
  navigationStyle: { type: 'string', enum: ['default', 'custom'], description: '导航栏样式。custom 时只保留右上角胶囊按钮。', default: 'default' },
  backgroundColor: { type: 'string', description: '窗口的背景色。', default: '#ffffff' },
  backgroundTextStyle: { type: 'string', enum: ['dark', 'light'], description: '下拉 loading 的样式。', default: 'dark' },
  enablePullDownRefresh: { type: 'boolean', description: '是否开启全局的下拉刷新。', default: false },
  onReachBottomDistance: { type: 'number', description: '页面上拉触底事件触发时距页面底部距离，单位 px。', default: 50 },
  disableScroll: { type: 'boolean', description: '设置为 true 则页面整体不能上下滚动（仅页面 json 有效）。', default: false },
}

const TABBAR_ITEM_SCHEMA: JSONSchema = {
  type: 'object',
  required: ['pagePath', 'text'],
  properties: {
    pagePath: { type: 'string', description: '页面路径，必须在 pages 中先定义。' },
    text: { type: 'string', description: 'tab 上按钮文字。' },
    iconPath: { type: 'string', description: '图片路径，相对小程序根目录。' },
    selectedIconPath: { type: 'string', description: '选中时的图片路径。' },
  },
  additionalProperties: false,
}

/** app.json schema. */
export const APP_JSON_SCHEMA: JSONSchema = {
  $id: 'dimina://schemas/app.json',
  type: 'object',
  required: ['pages'],
  properties: {
    pages: {
      type: 'array',
      description: '页面路径列表（不带扩展名），第一项为首页。',
      items: { type: 'string' },
    },
    window: {
      type: 'object',
      description: '全局的默认窗口表现。',
      properties: WINDOW_PROPERTIES,
    },
    tabBar: {
      type: 'object',
      description: '底部 tab 栏的表现。',
      required: ['list'],
      properties: {
        color: { type: 'string', description: 'tab 上文字默认颜色。' },
        selectedColor: { type: 'string', description: 'tab 上文字选中时的颜色。' },
        backgroundColor: { type: 'string', description: 'tab 的背景色。' },
        borderStyle: { type: 'string', enum: ['black', 'white'], description: 'tabBar 上边框颜色。' },
        position: { type: 'string', enum: ['bottom', 'top'], description: 'tabBar 的位置。', default: 'bottom' },
        list: {
          type: 'array',
          description: 'tab 列表，最少 2 个、最多 5 个。',
          minItems: 2,
          maxItems: 5,
          items: TABBAR_ITEM_SCHEMA,
        },
      },
    },
    subPackages: {
      type: 'array',
      description: '分包结构配置（也接受别名 subpackages）。',
      items: {
        type: 'object',
        required: ['root'],
        properties: {
          root: { type: 'string', description: '分包根目录。' },
          name: { type: 'string', description: '分包别名，可用于预下载。' },
          pages: { type: 'array', description: '分包内页面路径（相对 root）。', items: { type: 'string' } },
          independent: { type: 'boolean', description: '是否为独立分包。' },
        },
      },
    },
    subpackages: {
      type: 'array',
      description: 'subPackages 的别名，编译器一并识别。',
      items: { $ref: '#/properties/subPackages/items' },
    },
    usingComponents: {
      type: 'object',
      description: '全局自定义组件声明（组件名 → 组件路径）。',
      additionalProperties: { type: 'string' },
    },
    networkTimeout: {
      type: 'object',
      description: '各类网络请求的超时时间，单位 ms。',
      properties: {
        request: { type: 'number', default: 60000 },
        connectSocket: { type: 'number', default: 60000 },
        uploadFile: { type: 'number', default: 60000 },
        downloadFile: { type: 'number', default: 60000 },
      },
    },
    permission: {
      type: 'object',
      description: '小程序接口权限相关设置。',
      additionalProperties: {
        type: 'object',
        properties: { desc: { type: 'string', description: '权限用途说明。' } },
      },
    },
    requiredPrivateInfos: {
      type: 'array',
      description: '需要使用的地理位置相关接口列表。',
      items: { type: 'string' },
    },
    debug: { type: 'boolean', description: '是否开启 debug 模式。', default: false },
    entryPagePath: { type: 'string', description: '小程序默认启动首页。' },
  },
}

/** page *.json schema — window overrides + per-page component declarations. */
export const PAGE_JSON_SCHEMA: JSONSchema = {
  $id: 'dimina://schemas/page.json',
  type: 'object',
  properties: {
    ...WINDOW_PROPERTIES,
    component: { type: 'boolean', description: '声明该文件为自定义组件（组件的 json 需置 true）。' },
    usingComponents: {
      type: 'object',
      description: '页面 / 组件引用的自定义组件（组件名 → 组件路径）。',
      additionalProperties: { type: 'string' },
    },
    componentPlaceholder: {
      type: 'object',
      description: '分包异步化时组件的占位组件。',
      additionalProperties: { type: 'string' },
    },
  },
}

/** project.config.json schema — tool / project settings. */
export const PROJECT_CONFIG_SCHEMA: JSONSchema = {
  $id: 'dimina://schemas/project.config.json',
  type: 'object',
  properties: {
    description: { type: 'string', description: '项目说明。' },
    appid: { type: 'string', description: '小程序 appid。' },
    compileType: { type: 'string', enum: ['miniprogram', 'plugin'], description: '编译类型。', default: 'miniprogram' },
    libVersion: { type: 'string', description: '基础库版本。' },
    condition: { type: 'object', description: '编译条件配置。' },
    setting: {
      type: 'object',
      description: '项目设置。',
      properties: {
        urlCheck: { type: 'boolean', description: '是否检查安全域名和 TLS 版本。' },
        es6: { type: 'boolean', description: '是否启用 ES6 转 ES5。' },
        postcss: { type: 'boolean', description: '上传代码时是否自动补全样式前缀。' },
        minified: { type: 'boolean', description: '上传代码时是否压缩。' },
        newFeature: { type: 'boolean', description: '是否启用新特性。' },
        babelSetting: {
          type: 'object',
          properties: {
            ignore: { type: 'array', items: { type: 'string' } },
            disablePlugins: { type: 'array', items: { type: 'string' } },
            outputPath: { type: 'string' },
          },
        },
      },
    },
    packOptions: {
      type: 'object',
      description: '打包配置。',
      properties: {
        ignore: { type: 'array', items: { type: 'object' } },
        include: { type: 'array', items: { type: 'object' } },
      },
    },
    editorSetting: {
      type: 'object',
      description: '编辑器配置。',
      properties: {
        tabIndent: { type: 'string', enum: ['insertSpaces', 'tab'] },
        tabSize: { type: 'number' },
      },
    },
  },
}

/**
 * fileMatch → schema registry. `project.config.json` matches by exact filename;
 * `app.json` matches at the workspace root; everything else `*.json` is treated
 * as a page / component config (the permissive page schema), which is a superset
 * so it never false-flags app.json fields if a tool opens a non-root app.json.
 */
export interface DiminaJsonSchemaEntry {
  /** Glob fileMatch patterns, VS Code `json.schemas` style. */
  fileMatch: string[]
  /** Inline JSON Schema. */
  schema: JSONSchema
  /** Stable schema URI used for association + caching. */
  uri: string
}

export const DIMINA_JSON_SCHEMAS: DiminaJsonSchemaEntry[] = [
  { uri: 'dimina://schemas/app.json', fileMatch: ['app.json', '/app.json'], schema: APP_JSON_SCHEMA },
  { uri: 'dimina://schemas/project.config.json', fileMatch: ['project.config.json', 'project.private.config.json'], schema: PROJECT_CONFIG_SCHEMA },
  // Page / component config — match nested *.json under pages/components.
  { uri: 'dimina://schemas/page.json', fileMatch: ['/pages/**/*.json', '/components/**/*.json', '**/*.json'], schema: PAGE_JSON_SCHEMA },
]

const JSON_LANGUAGE_IDS = ['json', 'jsonc']

function pickSchemaUri(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('/project.config.json') || lower.endsWith('/project.private.config.json')) {
    return 'dimina://schemas/project.config.json'
  }
  // app.json at the workspace root (no further path segment after a folder).
  if (/(^|\/)app\.json$/.test(lower) && !/\/pages\//.test(lower) && !/\/components\//.test(lower)) {
    return 'dimina://schemas/app.json'
  }
  return 'dimina://schemas/page.json'
}

function jsonDoc(document: vscode.TextDocument): JsonTextDocument {
  return JsonTextDocument.create(
    document.uri.toString(),
    document.languageId,
    document.version,
    document.getText(),
  )
}

/**
 * Wire schema-driven completion / hover / diagnostics for the dimina config
 * files against the page-side `vscode` API. Self-contained: needs no JSON
 * language-features marketplace extension.
 *
 * Call from main.ts after `getApi()`:
 *   registerDiminaJsonSchemas(api)
 */
export function registerDiminaJsonSchemas(api: typeof vscode): vscode.Disposable {
  const ls: JsonLanguageService = getJsonLanguageService({})
  ls.configure({
    allowComments: true,
    schemas: DIMINA_JSON_SCHEMAS.map((e) => ({
      uri: e.uri,
      fileMatch: e.fileMatch,
      schema: e.schema,
    })),
  })

  const selector: vscode.DocumentSelector = JSON_LANGUAGE_IDS.map((language) => ({ language }))
  const disposables: vscode.Disposable[] = []
  const diagnostics = api.languages.createDiagnosticCollection('dimina-json')
  disposables.push(diagnostics)

  async function validate(document: vscode.TextDocument): Promise<void> {
    if (!JSON_LANGUAGE_IDS.includes(document.languageId)) return
    const path = document.uri.path
    // Only validate files our schemas cover; pickSchemaUri always returns one,
    // but skip files outside config-shaped paths to avoid noise on arbitrary JSON.
    if (!/(^|\/)(app\.json|project(\.private)?\.config\.json)$/.test(path) && !/\/(pages|components)\//.test(path)) {
      diagnostics.delete(document.uri)
      return
    }
    const doc = jsonDoc(document)
    const json = ls.parseJSONDocument(doc)
    const result = await ls.doValidation(doc, json, { schemaValidation: 'warning' })
    diagnostics.set(
      document.uri,
      result.map((d) => {
        const range = new api.Range(
          d.range.start.line,
          d.range.start.character,
          d.range.end.line,
          d.range.end.character,
        )
        const severity =
          d.severity === 1
            ? api.DiagnosticSeverity.Error
            : d.severity === 2
              ? api.DiagnosticSeverity.Warning
              : api.DiagnosticSeverity.Information
        const message = typeof d.message === 'string' ? d.message : (d.message as { value: string }).value
        const diag = new api.Diagnostic(range, message, severity)
        diag.source = 'dimina'
        return diag
      }),
    )
  }

  disposables.push(
    api.languages.registerCompletionItemProvider(
      selector,
      {
        async provideCompletionItems(document, position) {
          const doc = jsonDoc(document)
          const json = ls.parseJSONDocument(doc)
          const list = await ls.doComplete(
            doc,
            { line: position.line, character: position.character },
            json,
          )
          if (!list) return []
          return list.items.map((item) => {
            const ci = new api.CompletionItem(item.label)
            if (item.detail) ci.detail = item.detail
            if (item.documentation) {
              ci.documentation =
                typeof item.documentation === 'string'
                  ? item.documentation
                  : new api.MarkdownString(item.documentation.value)
            }
            if (typeof item.insertText === 'string') ci.insertText = item.insertText
            if (item.kind != null) ci.kind = (item.kind - 1) as vscode.CompletionItemKind
            return ci
          })
        },
      },
      '"',
      ':',
    ),
  )

  disposables.push(
    api.languages.registerHoverProvider(selector, {
      async provideHover(document, position) {
        const doc = jsonDoc(document)
        const json = ls.parseJSONDocument(doc)
        const hover = await ls.doHover(
          doc,
          { line: position.line, character: position.character },
          json,
        )
        if (!hover || hover.contents == null) return undefined
        const value =
          typeof hover.contents === 'string'
            ? hover.contents
            : Array.isArray(hover.contents)
              ? hover.contents.map((c) => (typeof c === 'string' ? c : c.value)).join('\n\n')
              : (hover.contents as { value: string }).value
        return new api.Hover(new api.MarkdownString(value))
      },
    }),
  )

  // Validate open + edited documents.
  disposables.push(api.workspace.onDidOpenTextDocument((d) => void validate(d)))
  disposables.push(api.workspace.onDidChangeTextDocument((e) => void validate(e.document)))
  disposables.push(api.workspace.onDidCloseTextDocument((d) => diagnostics.delete(d.uri)))
  for (const d of api.workspace.textDocuments) void validate(d)

  return api.Disposable.from(...disposables)
}

/**
 * Alternative activation for when the JSON language-features extension IS wired:
 * push the same schemas into the standard `json.schemas` setting so the built-in
 * server consumes them. Returns the value written (for assertions). Pairs with
 * `import '@codingame/monaco-vscode-json-language-features-default-extension'`.
 */
export async function applyDiminaJsonSchemaConfig(api: typeof vscode): Promise<unknown> {
  const value = DIMINA_JSON_SCHEMAS.map((e) => ({ fileMatch: e.fileMatch, schema: e.schema }))
  await api.workspace.getConfiguration('json').update('schemas', value, true)
  return value
}

export { pickSchemaUri }
