import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { checkPackedFiles, entryTargets, missingEntryFiles, unmodelledPublishConfig } from './check-publish-contract.js'

test('入口收集覆盖 exports 条件对象、main、types 与 bin', () => {
  assert.deepEqual(
    entryTargets({
      name: '@scope/pkg',
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
      bin: { pkg: './bin/cli.js' },
      exports: {
        '.': { types: './dist/index.d.ts', default: './dist/index.js' },
        './sub': './dist/sub.js',
        './package.json': './package.json',
      },
    }),
    ['./dist/index.d.ts', './dist/index.js', './dist/sub.js', './package.json', './bin/cli.js'],
  )
})

test('入口指向没被打包的文件时报出来', () => {
  const problems = checkPackedFiles(
    { exports: { '.': './dist/index.js', './sub': './dist/sub.js' } },
    ['dist/index.js', 'package.json'],
  )
  assert.equal(problems.length, 1)
  assert.match(problems[0], /\.\/dist\/sub\.js/)
  assert.match(problems[0], /files/)
})

test('声明的入口都在 tarball 里就没有问题', () => {
  assert.deepEqual(
    checkPackedFiles(
      { main: 'dist/index.js', exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } } },
      ['dist/index.js', 'dist/index.d.ts'],
    ),
    [],
  )
})

test('subpath pattern 只要求至少命中一个文件', () => {
  const exports = { './shared/*': './dist/shared/*.js' }
  assert.deepEqual(checkPackedFiles({ exports }, ['dist/shared/bridge.js']), [])

  const problems = checkPackedFiles({ exports }, ['dist/index.js'])
  assert.equal(problems.length, 1)
  assert.match(problems[0], /subpath pattern/)
})

test('pattern 里的点号按字面匹配，不当通配符', () => {
  const problems = checkPackedFiles({ exports: { './x/*': './dist/x/*.js' } }, ['dist/xAy-js'])
  assert.equal(problems.length, 1)
})

test('打包出测试文件要报出来——源码目录和编译产物里的都算', () => {
  const problems = checkPackedFiles({ exports: { '.': './dist/index.js' } }, [
    'dist/index.js',
    'src/client.test.ts',
    'dist/compile-log.test.d.ts',
    'src/__tests__/helper.ts',
    'types-fixture/consumer.ts',
  ])
  assert.equal(problems.length, 1)
  assert.match(problems[0], /4 个测试文件/)
})

test('test- 打头的脚本算测试文件，被声明成入口的除外', () => {
  const problems = checkPackedFiles({ exports: { '.': './dist/index.js' } }, [
    'dist/index.js',
    'scripts/test-node.js',
    'scripts/build-compiler.js',
  ])
  assert.equal(problems.length, 1)
  assert.match(problems[0], /1 个测试文件/)
  assert.match(problems[0], /scripts\/test-node\.js/)

  // 故意当 API 发出去的测试辅助工具（声明在 exports 里）不算。
  assert.deepEqual(
    checkPackedFiles(
      { exports: { '.': './dist/index.js', './test-utils': './dist/test-utils.js' } },
      ['dist/index.js', 'dist/test-utils.js'],
    ),
    [],
  )
})

test('名字里只是含 test 的文件正常发布', () => {
  assert.deepEqual(
    checkPackedFiles({ exports: { '.': './dist/index.js' } }, ['dist/index.js', 'dist/latest.js', 'src/attest.ts']),
    [],
  )
})

test('按 publishConfig 覆盖后的清单核对入口', () => {
  // design/view-anchor 的真实形状：源码里 main 指向 ./src/index.ts，发布出去指向
  // ./dist/index.js。只有按发布后的字段核对，才会发现 dist 没进 tarball。
  const pkgJson = {
    main: './src/index.ts',
    types: './src/index.ts',
    exports: { '.': './src/index.ts' },
    publishConfig: {
      access: 'public',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    },
  }
  assert.deepEqual(entryTargets(pkgJson), ['./dist/index.d.ts', './dist/index.js'])

  const problems = checkPackedFiles(pkgJson, ['src/index.ts', 'package.json'])
  assert.equal(problems.length, 2)
  assert.match(problems.join('\n'), /\.\/dist\/index\.js/)
})

test('imports、typings 和 typesVersions 指向的文件也要在 tarball 里', () => {
  assert.deepEqual(
    entryTargets({
      typings: 'dist/index.d.ts',
      imports: { '#internal': './dist/internal.js', '#dep': 'some-package' },
      typesVersions: { '*': { 'sub': ['dist/sub.d.ts'] } },
    }),
    ['./dist/internal.js', './dist/index.d.ts', './dist/sub.d.ts'],
  )

  const problems = checkPackedFiles({ imports: { '#internal': './dist/internal.js' } }, ['dist/index.js'])
  assert.equal(problems.length, 1)
  assert.match(problems[0], /\.\/dist\/internal\.js/)
})

test('browser 入口也要在 tarball 里', () => {
  // 字符串形式就是一个入口
  assert.deepEqual(entryTargets({ browser: './dist/browser.js' }), ['./dist/browser.js'])

  // 对象形式是替换表：只有指向本包文件的那一侧要发出去，false（禁用某个模块）和包名不是
  assert.deepEqual(
    entryTargets({ browser: { './dist/node.js': './dist/browser.js', 'node:fs': false, path: 'path-browserify' } }),
    ['./dist/browser.js'],
  )

  // publishConfig 同样能覆盖它
  assert.deepEqual(
    entryTargets({ browser: './src/browser.ts', publishConfig: { browser: './dist/browser.js' } }),
    ['./dist/browser.js'],
  )

  const problems = checkPackedFiles({ browser: './dist/browser.js' }, ['dist/index.js'])
  assert.equal(problems.length, 1)
  assert.match(problems[0], /\.\/dist\/browser\.js/)
})

test('test 和 tests 目录下的普通文件也算测试文件', () => {
  const problems = checkPackedFiles({}, ['package.json', 'test/helper.js', 'tests/integration.js', 'dist/__snapshots__/a.snap'])
  assert.equal(problems.length, 1)
  assert.match(problems[0], /3 个测试文件/)

  // 名字里含 test 的正常源文件不受影响
  assert.deepEqual(checkPackedFiles({}, ['dist/latest.js', 'dist/contest/index.js']), [])
})

test('publishConfig 里出现 npm pack 不认的字段时明确报错', () => {
  assert.deepEqual(unmodelledPublishConfig({ publishConfig: { access: 'public' } }), [])
  assert.deepEqual(unmodelledPublishConfig({ publishConfig: { files: ['dist'] } }), ['files'])
  assert.deepEqual(unmodelledPublishConfig({ publishConfig: { files: ['dist'], directory: 'dist' } }), ['files', 'directory'])
})

test('入口文件不在磁盘上时，报的是"没构建"而不是一串没进 tarball', () => {
  const dir = mkdtempSync(join(tmpdir(), 'publish-contract-'))
  const touch = (rel) => {
    mkdirSync(join(dir, dirname(rel)), { recursive: true })
    writeFileSync(join(dir, rel), '')
  }
  const pkgJson = {
    exports: { '.': './dist/index.js', './sub/*': './dist/sub/*.js' },
    types: 'dist/index.d.ts',
    bin: { demo: './bin/cli.js' },
  }

  assert.deepEqual(missingEntryFiles(pkgJson, dir), ['./dist/index.js', './dist/index.d.ts', './bin/cli.js'])

  // 只产出了一部分仍然算没齐——`files` 少写目录不会让文件从磁盘上消失，所以这里剩下的
  // 就是构建自己的问题，不该被当成构建齐了去跟 tarball 比。
  touch('dist/index.js')
  assert.deepEqual(missingEntryFiles(pkgJson, dir), ['./dist/index.d.ts', './bin/cli.js'])

  // subpath pattern 匹配一组文件，不参与这里的存在性判断
  touch('dist/index.d.ts')
  touch('bin/cli.js')
  assert.deepEqual(missingEntryFiles(pkgJson, dir), [])
})
