/**
 * WXML language intelligence, wired against the page-side `vscode` API object
 * (from the LocalProcess extension's getApi()).
 *
 * Registers the `wxml` language is handled by the built-in extension manifest
 * (contributes.languages, in main.ts); here we attach completion + hover
 * providers backed by vscode-html-languageservice fed with WXML customData.
 *
 * Why html-languageservice (not a hand-rolled provider): it already does the
 * tag/attr/value position analysis correctly; we only swap its tag/attribute
 * dictionary for the WXML one.
 */
import type * as vscode from 'vscode'
import {
  getLanguageService,
  TextDocument as LsTextDocument,
  type LanguageService,
  type CompletionItem as LsCompletionItem,
  type Range as LsRange,
  type InsertReplaceEdit,
  type TextEdit,
} from 'vscode-html-languageservice'
import { createWxmlDataProvider, WXML_LANGUAGE_ID } from './wxml-meta'

/**
 * Map an upstream LSP CompletionItem onto a vscode.CompletionItem.
 *
 * The html / json language services hand back items whose real insertion lives
 * in `textEdit` (a range-scoped replace) and whose `insertTextFormat` is mostly
 * `Snippet` (2) carrying `$1` / `${1:…}` / `$0` tab stops. Treating either as a
 * plain string leaks literal `${…}` placeholders into the buffer and, without
 * the textEdit range, fails to overwrite the quote/bracket already under the
 * cursor (duplicated `"` / `]`). So: honor Snippet via SnippetString and apply
 * the textEdit range so the replace lands where the service intended.
 */
function toVscodeCompletionItem(api: typeof vscode, item: LsCompletionItem): vscode.CompletionItem {
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
    const edit = item.textEdit as TextEdit | InsertReplaceEdit
    const lsRange: LsRange = 'range' in edit ? edit.range : edit.replace
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

function lsDoc(document: vscode.TextDocument): LsTextDocument {
  return LsTextDocument.create(
    document.uri.toString(),
    WXML_LANGUAGE_ID,
    document.version,
    document.getText(),
  )
}

export function registerWxmlLanguage(api: typeof vscode): vscode.Disposable {
  const ls: LanguageService = getLanguageService({
    useDefaultDataProvider: false,
    customDataProviders: [createWxmlDataProvider()],
  })

  const selector: vscode.DocumentSelector = { language: WXML_LANGUAGE_ID }
  const disposables: vscode.Disposable[] = []

  disposables.push(
    api.languages.registerCompletionItemProvider(
      selector,
      {
        provideCompletionItems(document, position) {
          const doc = lsDoc(document)
          const html = ls.parseHTMLDocument(doc)
          const result = ls.doComplete(
            doc,
            { line: position.line, character: position.character },
            html,
          )
          return result.items.map((item) => toVscodeCompletionItem(api, item))
        },
      },
      '<',
      ' ',
      ':',
      '"',
      "'",
    ),
  )

  disposables.push(
    api.languages.registerHoverProvider(selector, {
      provideHover(document, position) {
        const doc = lsDoc(document)
        const html = ls.parseHTMLDocument(doc)
        const hover = ls.doHover(
          doc,
          { line: position.line, character: position.character },
          html,
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

  return api.Disposable.from(...disposables)
}
