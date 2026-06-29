/**
 * TextMate grammar + language configuration for `wxml`, provided to the
 * built-in extension manifest as blob URLs (registerFileUrl). The grammar is a
 * trimmed HTML grammar: WXML is HTML-shaped (tags/attrs) plus `{{ }}` mustache
 * interpolation, which we scope as `meta.embedded` so it stands out.
 */

export const WXML_LANGUAGE_CONFIGURATION = {
  comments: { blockComment: ['<!--', '-->'] },
  brackets: [
    ['<!--', '-->'],
    ['<', '>'],
    ['{{', '}}'],
  ],
  autoClosingPairs: [
    { open: '{{', close: ' }}' },
    { open: '<!--', close: ' -->', notIn: ['comment', 'string'] },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  surroundingPairs: [
    ['<', '>'],
    ['"', '"'],
    ["'", "'"],
  ],
  onEnterRules: [],
}

export const WXML_TMGRAMMAR = {
  name: 'WXML',
  scopeName: 'text.html.wxml',
  patterns: [
    { include: '#comment' },
    { include: '#interpolation' },
    { include: '#tag' },
  ],
  repository: {
    comment: {
      name: 'comment.block.wxml',
      begin: '<!--',
      end: '-->',
    },
    interpolation: {
      name: 'meta.embedded.expression.wxml',
      begin: '\\{\\{',
      end: '\\}\\}',
      beginCaptures: { 0: { name: 'punctuation.section.embedded.begin.wxml' } },
      endCaptures: { 0: { name: 'punctuation.section.embedded.end.wxml' } },
      patterns: [{ include: 'source.js' }],
    },
    tag: {
      name: 'meta.tag.wxml',
      begin: '(</?)([a-zA-Z][\\w:-]*)',
      end: '(/?>)',
      beginCaptures: {
        1: { name: 'punctuation.definition.tag.wxml' },
        2: { name: 'entity.name.tag.wxml' },
      },
      endCaptures: { 1: { name: 'punctuation.definition.tag.wxml' } },
      patterns: [{ include: '#attribute' }, { include: '#interpolation' }],
    },
    attribute: {
      patterns: [
        {
          // wx:* and bind*/catch* directives stand out.
          match: '(wx:[a-zA-Z-]+|bind[a-zA-Z]+|catch[a-zA-Z]+)',
          name: 'entity.other.attribute-name.directive.wxml',
        },
        {
          match: '([a-zA-Z_][\\w:-]*)',
          name: 'entity.other.attribute-name.wxml',
        },
        {
          name: 'string.quoted.double.wxml',
          begin: '"',
          end: '"',
          patterns: [{ include: '#interpolation' }],
        },
        {
          name: 'string.quoted.single.wxml',
          begin: "'",
          end: "'",
          patterns: [{ include: '#interpolation' }],
        },
      ],
    },
  },
}

/** Build a blob URL serving `obj` as JSON (for registerFileUrl). */
export function jsonBlobUrl(obj: unknown): string {
  return URL.createObjectURL(new Blob([JSON.stringify(obj)], { type: 'application/json' }))
}
