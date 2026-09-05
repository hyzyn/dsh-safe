import test from 'node:test'
import assert from 'node:assert/strict'
import { parseFailureReport, summarizeLine } from '../lib/failures.js'

test('识别 assertEntriesLoaded 的 failed-to-load 名单', () => {
  const stderr = [
    'Error: dsh: plugin tree failed to load: dsh: plugin(s) failed to load: @linxin666/dsh-pet, dsh-better-sidebar; Cordis startup failed because these plugin(s) could not be resolved (see the error(s) logged above)',
    '    at async boot (file:///opt/dsh/index.js:1491:13)',
  ].join('\n')
  const { names, entryIds } = parseFailureReport(stderr)
  assert.deepEqual(names.map(([n]) => n).sort(), ['@linxin666/dsh-pet', 'dsh-better-sidebar'])
  assert.deepEqual(entryIds, [])
})

test('识别 assertEntriesActivated 的逐行失败（含 pending 与多行栈）', () => {
  const stderr = [
    'Error: dsh: plugin tree failed to load: dsh: 2 entries did not activate',
    '@shatyuka/dsh-llm-codebuddy: TypeError: ctx.clientUi.registerModule is not a function',
    '    at new SomePlugin (file:///x/node_modules/@shatyuka/dsh-llm-codebuddy/lib/index.js:10:5)',
    '    at file:///Users/me/.dsh/profiles/web/#abc123def',
    '@acme/pending-plugin: pending (waiting for services: codegraphClient, webserver)',
    '    at async boot (file:///opt/dsh/index.js:1503:5)',
  ].join('\n')
  const { names, entryIds } = parseFailureReport(stderr)
  assert.ok(names.some(([n]) => n === '@shatyuka/dsh-llm-codebuddy'))
  assert.ok(names.some(([n]) => n === '@acme/pending-plugin'))
  assert.ok(entryIds.some(([id]) => id === 'abc123def'))
})

test('识别 loader entry 更新失败的 id 与包名', () => {
  const stderr = [
    'Error: dsh: plugin tree failed to load: loader entries failed to apply',
    'AggregateError: loader entries failed to apply',
    'Error: failed to apply loader entry a1b2c3d4 (@hyzyn/dsh-env): some boom',
    '    at Object.apply (file:///x/index.js:1:1)',
    'Error: failed to import loader entry e5f6a7b8 (@acme/broken): Cannot find package',
  ].join('\n')
  const { names, entryIds } = parseFailureReport(stderr)
  assert.ok(names.some(([n]) => n === '@hyzyn/dsh-env'))
  assert.ok(names.some(([n]) => n === '@acme/broken'))
  assert.ok(entryIds.some(([id]) => id === 'a1b2c3d4'))
  assert.ok(entryIds.some(([id]) => id === 'e5f6a7b8'))
})

test('嵌套行 id（parent:child）与普通栈行不误报', () => {
  const stderr = [
    'Error: dsh: plugin tree failed to load: loader fibers failed',
    '    at file:///Users/me/.dsh/profiles/web/#tty-client:web-1',
    '    at SomeClass.method (file:///x/lib.js:2:3)',
  ].join('\n')
  const { entryIds } = parseFailureReport(stderr)
  assert.ok(entryIds.some(([id]) => id === 'tty-client:web-1'))
  // 普通栈行没有 #id，不应产生 entryIds
  assert.equal(entryIds.length, 1)
})

test('无关 stderr 不产生命中', () => {
  const { names, entryIds } = parseFailureReport('dsh: listening on http://localhost:3080\n')
  assert.deepEqual(names, [])
  assert.deepEqual(entryIds, [])
})

test('summarizeLine 压缩空白并截断', () => {
  const line = '  a   b\n c  '.repeat(40)
  const s = summarizeLine(line, 50)
  assert.ok(s.length <= 50)
  assert.ok(!s.includes('\n'))
  assert.equal(summarizeLine(''), 'startup failure')
})
