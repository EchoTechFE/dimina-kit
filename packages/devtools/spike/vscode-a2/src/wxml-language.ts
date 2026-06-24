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
} from 'vscode-html-languageservice'
import { createWxmlDataProvider, WXML_LANGUAGE_ID } from './wxml-meta'

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
          return result.items.map((item) => {
            const ci = new api.CompletionItem(item.label)
            if (item.detail) ci.detail = item.detail
            if (item.documentation) {
              ci.documentation =
                typeof item.documentation === 'string'
                  ? item.documentation
                  : new api.MarkdownString(item.documentation.value)
            }
            if (item.insertText) ci.insertText = item.insertText
            if (item.kind != null) ci.kind = (item.kind - 1) as vscode.CompletionItemKind
            return ci
          })
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
