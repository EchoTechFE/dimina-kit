import type * as vscode from 'vscode'
import { describe, expect, it } from 'vitest'
import { toVscodeCompletionItem, toVscodeHover } from './lsp-vscode.js'

/**
 * Minimal stand-ins for the vscode constructors these converters call.
 * The real `vscode` module only resolves inside the workbench iframe
 * runtime, so unit tests supply their own — each stub stores exactly what
 * it was constructed with, which is all these tests need to assert on.
 */
class StubCompletionItem {
  label: unknown
  kind?: number
  detail?: string
  documentation?: unknown
  sortText?: string
  filterText?: string
  insertText?: unknown
  range?: unknown
  constructor(label: unknown) {
    this.label = label
  }
}

class StubMarkdownString {
  value: string
  constructor(value: string) {
    this.value = value
  }
}

class StubSnippetString {
  value: string
  constructor(value: string) {
    this.value = value
  }
}

class StubRange {
  startLine: number
  startCharacter: number
  endLine: number
  endCharacter: number
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
    this.startLine = startLine
    this.startCharacter = startCharacter
    this.endLine = endLine
    this.endCharacter = endCharacter
  }
}

class StubHover {
  contents: unknown
  constructor(contents: unknown) {
    this.contents = contents
  }
}

const api = {
  CompletionItem: StubCompletionItem,
  MarkdownString: StubMarkdownString,
  SnippetString: StubSnippetString,
  Range: StubRange,
  Hover: StubHover,
} as unknown as typeof vscode

describe('toVscodeCompletionItem — plain field passthrough', () => {
  it('carries label into the constructor and copies detail/sortText/filterText verbatim', () => {
    const ci = toVscodeCompletionItem(api, {
      label: 'pages',
      detail: 'array of page paths',
      sortText: '0-pages',
      filterText: 'pages',
    })
    expect(ci.label).toBe('pages')
    expect(ci.detail).toBe('array of page paths')
    expect(ci.sortText).toBe('0-pages')
    expect(ci.filterText).toBe('pages')
  })

  it('does not set detail/sortText/filterText when the LSP item omits them', () => {
    const ci = toVscodeCompletionItem(api, { label: 'pages' })
    expect(ci.detail).toBeUndefined()
    expect(ci.sortText).toBeUndefined()
    expect(ci.filterText).toBeUndefined()
  })
})

describe('toVscodeCompletionItem — documentation normalization', () => {
  it('assigns a string documentation as-is, without wrapping it', () => {
    const ci = toVscodeCompletionItem(api, { label: 'x', documentation: 'plain text' })
    expect(ci.documentation).toBe('plain text')
  })

  it('wraps MarkupContent documentation in api.MarkdownString, keeping its value', () => {
    const ci = toVscodeCompletionItem(api, {
      label: 'x',
      documentation: { value: '**bold** docs' },
    })
    expect(ci.documentation).toBeInstanceOf(StubMarkdownString)
    expect((ci.documentation as StubMarkdownString).value).toBe('**bold** docs')
  })

  it('leaves documentation unset when the LSP item has none', () => {
    const ci = toVscodeCompletionItem(api, { label: 'x' })
    expect(ci.documentation).toBeUndefined()
  })
})

describe('toVscodeCompletionItem — kind off-by-one conversion', () => {
  it('subtracts 1 from the LSP kind so it lands on the vscode enum value', () => {
    // LSP CompletionItemKind.Function = 3 must become vscode's Function = 2.
    const ci = toVscodeCompletionItem(api, { label: 'foo', kind: 3 })
    expect(ci.kind).toBe(2)
  })

  it('does not set kind when the LSP item has no kind', () => {
    const ci = toVscodeCompletionItem(api, { label: 'foo' })
    expect(ci.kind).toBeUndefined()
  })

  it('does not set kind when the LSP item explicitly passes kind: null', () => {
    const ci = toVscodeCompletionItem(api, { label: 'foo', kind: null as unknown as undefined })
    expect(ci.kind).toBeUndefined()
  })

  it('still converts kind 1 to 0 rather than treating the falsy result as unset', () => {
    // Regression guard: `item.kind != null` (not truthiness) must gate this branch,
    // otherwise kind 1 -> 0 would be wrongly skipped.
    const ci = toVscodeCompletionItem(api, { label: 'foo', kind: 1 })
    expect(ci.kind).toBe(0)
  })
})

describe('toVscodeCompletionItem — snippet placeholders never leak as literal text', () => {
  it('wraps insertText in api.SnippetString when insertTextFormat is Snippet (2)', () => {
    const ci = toVscodeCompletionItem(api, {
      label: 'pages',
      insertTextFormat: 2,
      insertText: '"pages": [$1]',
    })
    expect(ci.insertText).toBeInstanceOf(StubSnippetString)
    expect((ci.insertText as StubSnippetString).value).toBe('"pages": [$1]')
  })

  it('keeps insertText as a plain string when insertTextFormat is PlainText (1)', () => {
    const ci = toVscodeCompletionItem(api, {
      label: 'pages',
      insertTextFormat: 1,
      insertText: '$1 is not a placeholder here',
    })
    expect(ci.insertText).toBe('$1 is not a placeholder here')
  })

  it('keeps insertText as a plain string when insertTextFormat is absent', () => {
    const ci = toVscodeCompletionItem(api, { label: 'pages', insertText: 'literal' })
    expect(ci.insertText).toBe('literal')
  })

  it('uses the label as the snippet body when insertTextFormat is Snippet but insertText is absent', () => {
    const ci = toVscodeCompletionItem(api, { label: '${1:tag}', insertTextFormat: 2 })
    expect(ci.insertText).toBeInstanceOf(StubSnippetString)
    expect((ci.insertText as StubSnippetString).value).toBe('${1:tag}')
  })

  it('leaves insertText unset when there is neither textEdit, insertText, nor Snippet format', () => {
    const ci = toVscodeCompletionItem(api, { label: 'plain-label' })
    expect(ci.insertText).toBeUndefined()
  })
})

describe('toVscodeCompletionItem — textEdit range selection', () => {
  it('applies a plain TextEdit range and its newText as insertText', () => {
    const ci = toVscodeCompletionItem(api, {
      label: 'wxss',
      textEdit: {
        range: { start: { line: 1, character: 2 }, end: { line: 1, character: 6 } },
        newText: 'wxss',
      },
    })
    const range = ci.range as unknown as StubRange
    expect(range).toBeInstanceOf(StubRange)
    expect([range.startLine, range.startCharacter, range.endLine, range.endCharacter]).toEqual([
      1, 2, 1, 6,
    ])
    expect(ci.insertText).toBe('wxss')
  })

  it('wraps a plain TextEdit newText in SnippetString when insertTextFormat is Snippet', () => {
    const ci = toVscodeCompletionItem(api, {
      label: 'x',
      insertTextFormat: 2,
      textEdit: {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: '${1:val}',
      },
    })
    expect(ci.insertText).toBeInstanceOf(StubSnippetString)
    expect((ci.insertText as StubSnippetString).value).toBe('${1:val}')
  })

  it('prefers the replace range over the insert range for an InsertReplaceEdit', () => {
    // Accepting a completion must overwrite the token under the cursor (replace),
    // not splice text in at the narrower insert point — using `insert` here would
    // duplicate the trailing characters of the token being completed.
    const ci = toVscodeCompletionItem(api, {
      label: 'view',
      textEdit: {
        newText: 'view',
        insert: { start: { line: 3, character: 5 }, end: { line: 3, character: 5 } },
        replace: { start: { line: 3, character: 2 }, end: { line: 3, character: 9 } },
      },
    })
    const range = ci.range as unknown as StubRange
    expect([range.startLine, range.startCharacter, range.endLine, range.endCharacter]).toEqual([
      3, 2, 3, 9,
    ])
  })

  it('uses the InsertReplaceEdit newText, not the label, as insertText', () => {
    const ci = toVscodeCompletionItem(api, {
      label: 'view-label',
      textEdit: {
        newText: 'view-newText',
        insert: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        replace: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
      },
    })
    expect(ci.insertText).toBe('view-newText')
  })

  it('takes priority over a sibling insertText field when both are present', () => {
    const ci = toVscodeCompletionItem(api, {
      label: 'x',
      insertText: 'ignored-plain-insert-text',
      textEdit: {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        newText: 'from-text-edit',
      },
    })
    expect(ci.insertText).toBe('from-text-edit')
  })
})

describe('toVscodeHover — missing content', () => {
  it('returns undefined for a null hover', () => {
    expect(toVscodeHover(api, null)).toBeUndefined()
  })

  it('returns undefined for an undefined hover', () => {
    expect(toVscodeHover(api, undefined)).toBeUndefined()
  })

  it('returns undefined when contents is null', () => {
    expect(toVscodeHover(api, { contents: null as unknown as string })).toBeUndefined()
  })
})

describe('toVscodeHover — contents normalization', () => {
  it('wraps a plain string content in api.MarkdownString unchanged', () => {
    const hover = toVscodeHover(api, { contents: 'hello' })
    expect(hover).toBeInstanceOf(StubHover)
    const md = (hover as unknown as StubHover).contents as StubMarkdownString
    expect(md).toBeInstanceOf(StubMarkdownString)
    expect(md.value).toBe('hello')
  })

  it('unwraps MarkupContent ({value}) into api.MarkdownString', () => {
    const hover = toVscodeHover(api, { contents: { value: '**bold**' } })
    const md = (hover as unknown as StubHover).contents as StubMarkdownString
    expect(md.value).toBe('**bold**')
  })

  it('joins a MarkedString[] array of plain strings with a blank line', () => {
    const hover = toVscodeHover(api, { contents: ['line one', 'line two'] })
    const md = (hover as unknown as StubHover).contents as StubMarkdownString
    expect(md.value).toBe('line one\n\nline two')
  })

  it('joins a MarkedString[] array mixing strings and {value} objects', () => {
    const hover = toVscodeHover(api, {
      contents: ['plain', { value: 'lang-tagged' }],
    })
    const md = (hover as unknown as StubHover).contents as StubMarkdownString
    expect(md.value).toBe('plain\n\nlang-tagged')
  })

  it('produces an empty joined string, not undefined, for an empty MarkedString[] array', () => {
    const hover = toVscodeHover(api, { contents: [] })
    const md = (hover as unknown as StubHover).contents as StubMarkdownString
    expect(md.value).toBe('')
  })
})
