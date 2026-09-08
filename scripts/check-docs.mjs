import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const documents = ['README.md', 'packages/devtools/README.md', 'docs/index.html']
const failures = []

function headingAnchor(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[\s]+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
}

function anchorsFor(file) {
  const content = readFileSync(file, 'utf8')
  if (extname(file) === '.html') return new Set([...content.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => id))
  return new Set(content.matchAll(/^#{1,6}\s+(.+)$/gm).map(([, heading]) => headingAnchor(heading)))
}

function localTarget(source, target) {
  const githubRoot = 'https://github.com/EchoTechFE/dimina-kit'
  if (target === githubRoot || target.startsWith(`${githubRoot}#`)) return resolve(repositoryRoot, 'README.md')
  if (target.startsWith(`${githubRoot}/blob/main/`)) return resolve(repositoryRoot, target.slice(`${githubRoot}/blob/main/`.length))
  if (target.startsWith(`${githubRoot}/tree/main/`)) return resolve(repositoryRoot, target.slice(`${githubRoot}/tree/main/`.length))
  if (/^[a-z][a-z+.-]*:/i.test(target) || target.startsWith('//')) return null
  return resolve(repositoryRoot, dirname(source), target)
}

function checkTarget(source, rawTarget) {
  const [pathPart, hash = ''] = rawTarget.split('#', 2)
  const file = localTarget(source, pathPart || `./${basename(source)}`)
  if (!file) return
  const relativeFile = normalize(file.slice(repositoryRoot.length + 1))
  if (!file.startsWith(`${repositoryRoot}/`) || !existsSync(file)) {
    failures.push(`${source}: 找不到 ${rawTarget}`)
    return
  }
  if (hash && decodeURIComponent(hash) !== 'readme' && ['.md', '.html'].includes(extname(file)) && !anchorsFor(file).has(decodeURIComponent(hash))) {
    failures.push(`${source}: ${rawTarget} 指向不存在的锚点`)
  }
  if (hash && !['.md', '.html'].includes(extname(file))) failures.push(`${source}: ${rawTarget} 不能校验非文档锚点 (${relativeFile})`)
}

for (const source of documents) {
  const content = readFileSync(resolve(repositoryRoot, source), 'utf8')
  const targets = source.endsWith('.md')
    ? [...content.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)].map(([, target]) => target)
    : [...content.matchAll(/(?:href|src)="([^"]+)"/g)].map(([, target]) => target)
  for (const target of targets) checkTarget(source, target)
}

if (failures.length) {
  console.error(`文档链接检查失败（${failures.length} 项）：`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('文档链接检查通过。')
}
