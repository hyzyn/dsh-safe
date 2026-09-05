import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DSH_SAFE_LANG = 'zh' // 本文件的 t() 断言固定中文（测试文件独立进程运行）

const { verifyParser } = await import('../lib/verify.js')

const GOOD_STDERR = [
  'Error: dsh: plugin tree failed to load: loader entries failed to apply',
  'Error: failed to import loader entry dsh-safe-verify (@dsh-safe-verify/broken): Cannot find package',
  '    at Object.import (file:///opt/dsh/lib/loader.js:244:9)',
].join('\n')

const makeLog = () => {
  const lines = []
  return { lines, log: (line) => lines.push(line) }
}

test('自校验：新版报错能识别坏插件 → 通过', async () => {
  const { lines, log } = makeLog()
  const ok = await verifyParser({ log, spawn: () => ({ status: 1, stderr: GOOD_STDERR }) })
  assert.equal(ok, true)
  assert.ok(lines.some((l) => l.includes('正在自校验')))
  assert.ok(lines.some((l) => l.includes('自校验通过')))
})

test('自校验：报错里识别不出坏插件 → 失败并提示回滚命令', async () => {
  const { lines, log } = makeLog()
  const ok = await verifyParser({ log, spawn: () => ({ status: 1, stderr: 'dsh: some unrelated crash\n' }), rollbackVersion: '0.1.0' })
  assert.equal(ok, false)
  assert.ok(lines.some((l) => l.includes('未通过') && l.includes('update --to 0.1.0')))
})

test('自校验：坏插件试启意外成功 → 失败', async () => {
  const { lines, log } = makeLog()
  const ok = await verifyParser({ log, spawn: () => ({ status: 0, stderr: '' }) })
  assert.equal(ok, false)
  assert.ok(lines.some((l) => l.includes('意外成功')))
})

test('自校验：试启超时/无法启动 → 结论为未验证', async () => {
  const { lines, log } = makeLog()
  const ok = await verifyParser({ log, spawn: () => ({ status: null, stderr: '' }) })
  assert.equal(ok, false)
  assert.ok(lines.some((l) => l.includes('未完成')))
})
