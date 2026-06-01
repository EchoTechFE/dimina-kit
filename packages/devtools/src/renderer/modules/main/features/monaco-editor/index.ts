/**
 * In-renderer Monaco code editor for the dimina project window's `editor`
 * cell. Replaces the embedded OpenSumi editor (WebContentsView +
 * `dmieditor://`). Self-contained: languages, theme, file access and the
 * editor UI all live under this directory.
 */
export { MonacoEditor } from './components/MonacoEditor'
export { ensureDiminaLanguages, languageForPath } from './language/register'
