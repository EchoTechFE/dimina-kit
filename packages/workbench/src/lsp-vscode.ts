/**
 * Shared LSP → vscode API conversions used by every language provider wired
 * against the page-side `vscode` object (from LocalProcess's getApi()):
 * dimina-json-schemas.ts (vscode-json-languageservice) and wxml-language.ts
 * (vscode-html-languageservice).
 *
 * Both language services return the same LSP-shaped `CompletionItem` /
 * `Hover` types (they're both built on `vscode-languageserver-types`), so
 * these converters are duck-typed against the LSP shape rather than either
 * service's re-exported aliases — that keeps this module import-free of
 * either language service package.
 */
import type * as vscode from 'vscode'

interface LspPosition {
  line: number
  character: number
}

interface LspRange {
  start: LspPosition
  end: LspPosition
}

interface LspTextEdit {
  range: LspRange
  newText: string
}

/**
 * Subset of the LSP `InsertReplaceEdit` (not every language service
 * re-exports this type). A completion's `textEdit` is either a plain
 * `TextEdit` (`range`) or this (`insert`/`replace`).
 */
interface LspInsertReplaceEdit {
  newText: string
  insert: LspRange
  replace: LspRange
}

interface LspCompletionItem {
  label: string
  detail?: string
  documentation?: string | { value: string }
  sortText?: string
  filterText?: string
  kind?: number
  insertTextFormat?: number
  insertText?: string
  textEdit?: LspTextEdit | LspInsertReplaceEdit
}

/**
 * Map an upstream LSP CompletionItem onto a vscode.CompletionItem.
 *
 * The html / json language services hand back items whose real insertion
 * lives in `textEdit` (a range-scoped replace) and whose `insertTextFormat`
 * is mostly `Snippet` (2) carrying `$1` / `${1:…}` / `$0` tab stops (e.g.
 * `"pages": [$1]`). Treating either as a plain string leaks literal `${…}`
 * placeholders into the buffer and, without the textEdit range, fails to
 * overwrite the quote/bracket already under the cursor (duplicated `"` /
 * `]`). So: honor Snippet via SnippetString and apply the textEdit range so
 * the replace lands where the service intended.
 */
export function toVscodeCompletionItem(
  api: typeof vscode,
  item: LspCompletionItem,
): vscode.CompletionItem {
  const ci = new api.CompletionItem(item.label)
  if (item.detail) ci.detail = item.detail
  if (item.documentation) {
    ci.documentation =
      typeof item.documentation === 'string'
        ? item.documentation
        : new api.MarkdownString(item.documentation.value)
  }
  if (item.sortText) ci.sortText = item.sortText
  if (item.filterText) ci.filterText = item.filterText
  if (item.kind != null) ci.kind = (item.kind - 1) as vscode.CompletionItemKind

  const isSnippet = item.insertTextFormat === 2
  const text = (value: string): string | vscode.SnippetString =>
    isSnippet ? new api.SnippetString(value) : value

  if (item.textEdit) {
    // InsertReplaceEdit carries two ranges (insert/replace); prefer replace so
    // accepting overwrites the token under the cursor rather than splicing in.
    const edit = item.textEdit
    const lsRange: LspRange = 'range' in edit ? edit.range : edit.replace
    ci.range = new api.Range(
      lsRange.start.line,
      lsRange.start.character,
      lsRange.end.line,
      lsRange.end.character,
    )
    ci.insertText = text(edit.newText)
  } else if (item.insertText != null) {
    ci.insertText = text(item.insertText)
  } else if (isSnippet) {
    // Snippet format with no explicit insertText: the label IS the snippet body.
    ci.insertText = new api.SnippetString(item.label)
  }
  return ci
}

interface LspHover {
  contents: string | { value: string } | Array<string | { value: string }>
}

/**
 * Map an upstream LSP Hover onto a vscode.Hover, or undefined when there's
 * no content to show. `contents` is one of LSP's three legal Hover shapes
 * (string / MarkupContent / MarkedString[]) — normalize all three to a
 * single Markdown string, joining array entries with a blank line.
 */
export function toVscodeHover(
  api: typeof vscode,
  hover: LspHover | null | undefined,
): vscode.Hover | undefined {
  if (!hover || hover.contents == null) return undefined
  const value =
    typeof hover.contents === 'string'
      ? hover.contents
      : Array.isArray(hover.contents)
        ? hover.contents.map((c) => (typeof c === 'string' ? c : c.value)).join('\n\n')
        : hover.contents.value
  return new api.Hover(new api.MarkdownString(value))
}
