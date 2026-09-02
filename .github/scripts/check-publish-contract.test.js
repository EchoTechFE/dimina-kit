import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkPackedFiles, entryTargets } from './check-publish-contract.js'

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

test('名字里带 test 但不是测试文件的正常发布', () => {
  assert.deepEqual(
    checkPackedFiles({ exports: { '.': './dist/index.js' } }, ['dist/index.js', 'dist/test-utils.js', 'src/latest.ts']),
    [],
  )
})
