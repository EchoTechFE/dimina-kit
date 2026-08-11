/**
 * Copies `src/simulator-ui`'s stylesheets next to the JavaScript `tsc` emits
 * for them. The components import their stylesheet for its side effect, and
 * `tsc` keeps that import in the output while having no idea what a `.css`
 * file is — so without this step the published bundle points at stylesheets
 * that are not in it, and the consumer's bundler fails to resolve them.
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = dirname(fileURLToPath(import.meta.url))
const sourceDir = join(packageDir, 'src/simulator-ui')
const outputDir = join(packageDir, 'dist/simulator-ui')

mkdirSync(outputDir, { recursive: true })

const stylesheets = readdirSync(sourceDir).filter(name => name.endsWith('.css'))
if (stylesheets.length === 0) {
  throw new Error(`build-simulator-ui-css: no stylesheets found in ${sourceDir}`)
}

for (const name of stylesheets) {
  copyFileSync(join(sourceDir, name), join(outputDir, name))
}
