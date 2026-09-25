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

test('环境类失败（端口被占）只进 environmental，不进隔离候选', () => {
  const stderr = [
    'Error: dsh: plugin tree failed to load: loader entries failed to apply',
    '[cause]: Error: failed to apply loader entry webserver (@deepseek-ai/dsh-host-webserver): listen EADDRINUSE: address already in use 0.0.0.0:3080',
  ].join('\n')
  const { names, entryIds, environmental } = parseFailureReport(stderr)
  // 端口被占不是插件的错：禁用它既修不好问题，又会连带误伤依赖它的插件
  assert.deepEqual(names, [])
  assert.deepEqual(entryIds, [])
  assert.ok(environmental.some(([label, line]) => label === 'webserver' && line.includes('EADDRINUSE')))
})

test('"did not activate" 块里的环境类失败同样不进候选，真失败不受影响', () => {
  const stderr = [
    'Error: dsh: plugin tree failed to load: dsh: 2 entries did not activate',
    '@acme/net-plugin: Error: connect ECONNREFUSED 127.0.0.1:6379',
    '@acme/truly-broken: TypeError: ctx.foo is not a function',
  ].join('\n')
  const { names, entryIds, environmental } = parseFailureReport(stderr)
  assert.ok(!names.some(([n]) => n === '@acme/net-plugin'))
  assert.ok(names.some(([n]) => n === '@acme/truly-broken'))
  assert.ok(environmental.some(([label]) => label === '@acme/net-plugin'))
  assert.deepEqual(entryIds, [])
})

test('非 errno 的 apply 失败仍照常进候选（环境过滤不放宽）', () => {
  const stderr = 'Error: failed to apply loader entry a1b2c3d4 (@acme/x): boom\n'
  const { names, entryIds, environmental } = parseFailureReport(stderr)
  assert.ok(names.some(([n]) => n === '@acme/x'))
  assert.ok(entryIds.some(([id]) => id === 'a1b2c3d4'))
  assert.deepEqual(environmental, [])
})

test('summarizeLine 压缩空白并截断', () => {
  const line = '  a   b\n c  '.repeat(40)
  const s = summarizeLine(line, 50)
  assert.ok(s.length <= 50)
  assert.ok(!s.includes('\n'))
  assert.equal(summarizeLine(''), 'startup failure')
})

// ---- dsh ≥ 0.1.6 的结构化启动诊断（app-boot auditStartupEntries）----

test('0.1.6+ 宽容告警：行 id 与包名都准确，required 为空', () => {
  const stderr = [
    'dsh: warning: 1 entry did not activate',
    'broken-comm (@acme/broken-plugin): failed to import',
  ].join('\n')
  const { names, entryIds, required, inactive } = parseFailureReport(stderr)
  assert.deepEqual(names.map(([n]) => n), ['@acme/broken-plugin'])
  assert.deepEqual(entryIds.map(([id]) => id), ['broken-comm'])
  assert.deepEqual(required, [])
  assert.equal(inactive.length, 1)
  assert.equal(inactive[0].required, false)
  assert.equal(inactive[0].detail, 'failed to import')
})

test('0.1.6+ 致命诊断：Failed plugins 与 pending 表格都解析，required 显式标注', () => {
  const stderr = [
    'dsh: startup failed: 1 required plugin did not activate',
    '',
    'Failed plugins (1):',
    '  badplug',
    '    Package: @acme/broken-plugin',
    '    Error: boom',
    '    at file:///x/lib/index.js:3:11',
    '',
    'Plugins waiting for services (1):',
    '  Plugin                Missing services',
    '  connection (required)  webServer',
    '',
  ].join('\n')
  const { names, entryIds, required, inactive } = parseFailureReport(stderr)
  assert.deepEqual(names.map(([n]) => n), ['@acme/broken-plugin'])
  assert.deepEqual(entryIds.map(([id]) => id).sort(), ['badplug', 'connection'])
  assert.deepEqual(required, ['connection'])
  const bad = inactive.find((item) => item.id === 'badplug')
  assert.equal(bad.name, '@acme/broken-plugin')
  assert.equal(bad.required, false)
  assert.ok(bad.detail.includes('Error: boom'))
  const pending = inactive.find((item) => item.id === 'connection')
  assert.equal(pending.name, null)
  assert.equal(pending.required, true)
  assert.ok(pending.detail.includes('webServer'))
  // 表格列头行（Plugin / Missing services）不是条目
  assert.ok(!inactive.some((item) => item.id === 'Plugin'))
})

test('0.1.6+ 新格式不再产出 Package / Error 这类假包名（0.17.0 实测缺陷）', () => {
  const stderr = [
    'dsh: startup failed: 1 required plugin did not activate',
    '',
    'Failed plugins (1):',
    '  webserver (required)',
    '    Package: @deepseek-ai/dsh-host-webserver',
    '    Error: listen EADDRINUSE: address already in use 0.0.0.0:3080',
    '',
  ].join('\n')
  const { names, entryIds, environmental, required } = parseFailureReport(stderr)
  assert.deepEqual(names.map(([n]) => n), ['@deepseek-ai/dsh-host-webserver'])
  assert.ok(!names.some(([n]) => n === 'Package' || n === 'Error'))
  assert.deepEqual(entryIds.map(([id]) => id), ['webserver'])
  assert.deepEqual(required, ['webserver'])
  // required 条目因端口被占而失败：仍是环境类失败，调用方不得隔离
  assert.deepEqual(environmental.map(([label]) => label), ['webserver'])
})

test('0.1.6+ 诊断后跟的 "Full diagnostics:" 行不会被吃成条目详情', () => {
  const stderr = [
    'dsh: startup failed: 1 required plugin did not activate',
    '',
    'Failed plugins (1):',
    '  webserver (required)',
    '    Package: @deepseek-ai/dsh-host-webserver',
    '    failed to import',
    '',
    'Full diagnostics: /Users/me/.dsh/logs/startup-x.log',
  ].join('\n')
  const { inactive } = parseFailureReport(stderr)
  assert.equal(inactive.length, 1)
  assert.equal(inactive[0].detail, 'failed to import')
})
