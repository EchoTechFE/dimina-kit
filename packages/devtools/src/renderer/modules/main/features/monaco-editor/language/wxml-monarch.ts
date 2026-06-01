/**
 * Monarch tokenizer + language configuration for `wxml`.
 *
 * Why Monarch (not TextMate): pure Monaco does not run TextMate grammars
 * without an external Oniguruma WASM engine. WXML is an HTML-like markup
 * with mustache interpolation (`{{ }}`), `wx:` directives and
 * `bind*`/`catch*` event attributes — all expressible in Monarch without
 * the WASM cost. If advanced highlighting is ever needed we can layer
 * `vscode-textmate` later; the public language id (`wxml`) stays stable.
 */
import type { languages } from 'monaco-editor'

export const wxmlLanguageConfiguration: languages.LanguageConfiguration = {
  comments: { blockComment: ['<!--', '-->'] },
  brackets: [
    ['<', '>'],
    ['{{', '}}'],
  ],
  autoClosingPairs: [
    { open: '<', close: '>' },
    { open: '{{', close: '}}' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  surroundingPairs: [
    { open: '<', close: '>' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  onEnterRules: [
    {
      // Indent between a freshly-opened tag and its close tag.
      beforeText: /<([a-zA-Z][\w-]*)(?:[^>]*[^/>])?>$/,
      afterText: /^<\/([a-zA-Z][\w-]*)>$/,
      action: { indentAction: 2 /* IndentAction.IndentOutdent */ },
    },
  ],
}

export const wxmlMonarchLanguage: languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.wxml',
  ignoreCase: true,

  // Recognised separately so attribute highlighting can flag them.
  wxmlDirectives: [
    'wx:if',
    'wx:elif',
    'wx:else',
    'wx:for',
    'wx:for-item',
    'wx:for-index',
    'wx:key',
  ],

  tokenizer: {
    root: [
      // mustache interpolation anywhere in text content
      [/\{\{/, { token: 'delimiter.mustache', next: '@mustache' }],
      [/<!--/, { token: 'comment', next: '@comment' }],
      // closing tag
      [/(<\/)([a-zA-Z][\w-]*)(\s*>)/, ['delimiter', 'tag', 'delimiter']],
      // opening tag — enter attribute state
      [/(<)([a-zA-Z][\w-]*)/, ['delimiter', { token: 'tag', next: '@tag' }]],
      [/[^<{]+/, ''],
      [/[<{]/, ''],
    ],

    comment: [
      [/-->/, { token: 'comment', next: '@pop' }],
      [/[^-]+/, 'comment'],
      [/./, 'comment'],
    ],

    mustache: [
      [/\}\}/, { token: 'delimiter.mustache', next: '@pop' }],
      [/[^}]+/, 'variable'],
      [/\}/, 'variable'],
    ],

    tag: [
      [/\s+/, ''],
      // self-close / close of the open tag
      [/\/?>/, { token: 'delimiter', next: '@pop' }],
      // wx: directives + bind/catch events get a keyword-ish color
      [/(wx:[\w-]+)/, 'keyword'],
      [/((?:bind|catch|capture-bind|capture-catch|mut-bind):?[\w-]+)/, 'keyword'],
      // attribute name
      [/[a-zA-Z_][\w:-]*/, 'attribute.name'],
      [/=/, 'delimiter'],
      // attribute values (may embed mustache)
      [/"/, { token: 'attribute.value', next: '@dquote' }],
      [/'/, { token: 'attribute.value', next: '@squote' }],
    ],

    dquote: [
      [/\{\{/, { token: 'delimiter.mustache', next: '@mustache' }],
      [/"/, { token: 'attribute.value', next: '@pop' }],
      [/[^"{]+/, 'attribute.value'],
      [/[{]/, 'attribute.value'],
    ],

    squote: [
      [/\{\{/, { token: 'delimiter.mustache', next: '@mustache' }],
      [/'/, { token: 'attribute.value', next: '@pop' }],
      [/[^'{]+/, 'attribute.value'],
      [/[{]/, 'attribute.value'],
    ],
  },
}
