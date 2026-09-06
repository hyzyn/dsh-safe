import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.DSH_SAFE_LANG = 'zh' // 本文件的 t() 断言固定中文（测试文件独立进程运行）

const { cmdExplain } = await import('../lib/ai.js')

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BIN = join(ROOT, 'bin', 'dsh-safe.js')

const originalFetch = globalThis.fetch
const originalKey = process.env.DSH_SAFE_AI_KEY
test.after(() => {
  globalThis.fetch = originalFetch
  if (originalKey === undefined) delete process.env.DSH_SAFE_AI_KEY
  else process.env.DSH_SAFE_AI_KEY = originalKey
})

const okResponse = (content) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) })

const RESOLVE_REASON =
  "Error: failed to import loader entry badplug (@acme/broken-plugin): Cannot find package '@acme/broken-plugin'"
const ENTRY = {
  id: 'badplug',
  name: '@acme/broken-plugin',
  reason: RESOLVE_REASON,
  quarantinedAt: '2026-01-01T00:00:00.000Z',
  file: '/x/cordis.patch.yml',
}

function makeFixture({ withFailureLog = false, ledgerEntries = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-safe-explain-'))
  const dir = join(home, 'dsh-safe')
  mkdirSync(dir, { recursive: true })
  if (withFailureLog) writeFileSync(join(dir, 'last-failure-web.log'), `boom at ${homedir()}/x\n`)
  if (ledgerEntries) {
    writeFileSync(join(dir, 'quarantine.json'), JSON.stringify({ version: 1, profiles: { web: ledgerEntries } }, null, 2))
  }
  return { home }
}

function hooks(overrides = {}) {
  const lines = []
  const written = []
  return { log: (l) => lines.push(l), write: (l) => written.push(l), ...overrides, lines, written }
}

test('explain <id>：解读隔离记录（原因进入提示词，含 repair 建议）', async () => {
  process.env.DSH_SAFE_AI_KEY = 'test-key'
  const fx = makeFixture({ ledgerEntries: [ENTRY] })
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return okResponse('包损坏，重装即可修复')
  }
  const h = hooks()
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await cmdExplain(['badplug'], h)
    assert.equal(code, 0)
    assert.ok(h.lines.some((l) => l.includes('解读隔离记录 badplug')))
    assert.equal(h.written[0], '包损坏，重装即可修复')
    const prompt = JSON.stringify(calls[0].body)
    assert.ok(prompt.includes('Cannot find package'))
    assert.ok(prompt.includes('dsh-safe repair'))
  } finally {
    process.env.DSH_HOME = oldHome
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('explain：无失败日志但有台账 → 解读隔离台账', async () => {
  process.env.DSH_SAFE_AI_KEY = 'test-key'
  const fx = makeFixture({ ledgerEntries: [ENTRY] })
  globalThis.fetch = async () => okResponse('摘要')
  const h = hooks({ isTTY: true })
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await cmdExplain([], h)
    assert.equal(code, 0)
    assert.ok(h.lines.some((l) => l.includes('解读隔离台账（1 条）')))
  } finally {
    process.env.DSH_HOME = oldHome
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('explain：默认优先最近失败日志（而非台账）', async () => {
  process.env.DSH_SAFE_AI_KEY = 'test-key'
  const fx = makeFixture({ withFailureLog: true, ledgerEntries: [ENTRY] })
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return okResponse('解读')
  }
  const h = hooks({ isTTY: true })
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await cmdExplain([], h)
    assert.equal(code, 0)
    assert.ok(h.lines.some((l) => l.includes('解读最近一次失败记录')))
    assert.ok(!h.lines.some((l) => l.includes('解读隔离台账')))
    assert.ok(JSON.stringify(calls[0].body).includes('~/x')) // 失败日志进了提示词且脱敏
  } finally {
    process.env.DSH_HOME = oldHome
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('explain <id>：台账里不存在 → 报错', async () => {
  process.env.DSH_SAFE_AI_KEY = 'test-key'
  const fx = makeFixture({ ledgerEntries: [ENTRY] })
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await cmdExplain(['nope'], hooks({ isTTY: true, log: (l) => lines.push(l) }))
    assert.equal(code, 1)
    assert.ok(lines.some((l) => l.includes('没有找到 nope')))
  } finally {
    process.env.DSH_HOME = oldHome
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('explain：未知旗标 → 严格报错，不静默吞', async () => {
  const lines = []
  let fetchCalled = false
  globalThis.fetch = async () => {
    fetchCalled = true
    return okResponse('x')
  }
  const code = await cmdExplain(['--unknown-flag'], hooks({ isTTY: true, log: (l) => lines.push(l) }))
  assert.equal(code, 2)
  assert.ok(lines.some((l) => l.includes('无法识别的参数') && l.includes('--unknown-flag')))
  assert.equal(fetchCalled, false)
})

test('explain：--file 读日志解读', async () => {
  process.env.DSH_SAFE_AI_KEY = 'test-key'
  const fx = makeFixture({ withFailureLog: true })
  globalThis.fetch = async () => okResponse('解读')
  const written = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await cmdExplain(['--file', join(fx.home, 'dsh-safe', 'last-failure-web.log')], {
      isTTY: true,
      log: () => {},
      write: (l) => written.push(l),
    })
    assert.equal(code, 0)
    assert.equal(written[0], '解读')
  } finally {
    process.env.DSH_HOME = oldHome
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('explain：AI 未启用 → 指引设置 key', async () => {
  delete process.env.DSH_SAFE_AI_KEY
  const lines = []
  const code = await cmdExplain([], hooks({ isTTY: true, log: (l) => lines.push(l) }))
  assert.equal(code, 1)
  assert.ok(lines.some((l) => l.includes('DSH_SAFE_AI_KEY')))
})

test('explain：无任何可解读来源 → 用法指引', async () => {
  process.env.DSH_SAFE_AI_KEY = 'test-key'
  const fx = makeFixture()
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await cmdExplain([], hooks({ isTTY: true, log: (l) => lines.push(l) }))
    assert.equal(code, 2)
    assert.ok(lines.some((l) => l.includes('last-failure-<profile>.log')))
  } finally {
    process.env.DSH_HOME = oldHome
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('包装启动失败 → stderr 自动持久化并提示 explain', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-safe-explain-cli-'))
  const binDir = join(home, 'bin')
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  mkdirSync(binDir, { recursive: true })
  const dshBin = join(binDir, 'dsh')
  writeFileSync(dshBin, `#!/usr/bin/env node\nprocess.stderr.write('Error: custom boom\\n')\nprocess.exit(1)\n`)
  chmodSync(dshBin, 0o755)
  const result = spawnSync(process.execPath, [BIN, 'web'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_HOME: home,
      PATH: `${binDir}:${process.env.PATH}`,
      DSH_SAFE_LANG: 'zh',
      DSH_SAFE_NO_UPDATE_CHECK: '1',
    },
  })
  try {
    assert.equal(result.status, 1)
    const failureFile = join(home, 'dsh-safe', 'last-failure-web.log')
    assert.equal(readFileSync(failureFile, 'utf8'), 'Error: custom boom\n')
    assert.ok(result.stderr.includes('可运行 dsh-safe explain'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
