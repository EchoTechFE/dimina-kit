/**
 * Built-in template catalog. Each entry's `source.path` points at a
 * directory inside `<devtools-package-root>/templates/`, which is
 * committed to the repo and (via the `files` field of package.json's
 * publish manifest) included in the published tarball.
 */
import path from 'node:path'
import type { ProjectTemplate } from './types.js'
import { devtoolsPackageRoot } from '../../utils/paths.js'

const TEMPLATES_DIR = path.join(devtoolsPackageRoot, 'templates')

export const BUILTIN_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'blank',
    name: 'Blank',
    description: '最小骨架：app.* + 一个 index 页面',
    source: { type: 'directory', path: path.join(TEMPLATES_DIR, 'blank') },
  },
  {
    id: 'taro-todo',
    name: 'Taro Todo',
    description: 'Taro 编译产物的 Todo 示例',
    source: { type: 'directory', path: path.join(TEMPLATES_DIR, 'taro-todo') },
  },
]
