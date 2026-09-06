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

function makeFixture({ withFailure = true, profile = 'web' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-safe-explain-'))
  const dir = join(home, 'dsh-safe')
  mkdirSync(dir, { recursive: true })
  if (withFailure) {
    mkdirSync(join(home, 'profiles', profile), { recursive: true })
    writeFileSync(join(dir, `last-failure-${profile}.log`), `boom at ${homedir()}/x\n`)
  }
  return { home, dir }
}

function hooks(overrides = {}) {
  const lines = []
  const written = []
  return { log: (l) => lines.push(l), write: (l) => written.push(l), ...overrides, lines, written }
}

test('explain：默认解读最近一次失败记录（home 路径脱敏）', async () => {
  process.env.DSH_SAFE_AI_KEY = 'test-key'
  const fx = makeFixture()
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return okResponse('原因：坏插件')
  }
  const h = hooks({ isTTY: true })
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await cmdExplain([], h)
    assert.equal(code, 0)
    assert.ok(h.lines.some((l) => l.includes('解读最近一次失败记录')))
    assert.equal(h.written[0], '原因：坏插件')
    assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions')
    assert.ok(!JSON.stringify(calls[0].body).includes(homedir()))
    assert.ok(JSON.stringify(calls[0].body).includes('~/x'))
  } finally {
    process.env.DSH_HOME = oldHome
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('explain：未知参数 → 严格报错，不静默吞', async () => {
  process.env.DSH_SAFE_AI_KEY = 'test-key'
  const fx = makeFixture({ withFailure: false })
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    let called = false
    const code = await cmdExplain(['describe-image', '--profile', 'web'], {
      spawn: () => {
        called = true
        return { status: 0, stderr: '' }
      },
      isTTY: true,
      log: (l) => lines.push(l),
      write: () => {},
    })
    assert.equal(code, 2)
    assert.ok(lines.some((l) => l.includes('无法识别的参数') && l.includes('describe-image')))
    assert.equal(called, false)
  } finally {
    process.env.DSH_HOME = oldHome
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('explain：-- 之后的参数透传给 dsh 试启', async () => {
  process.env.DSH_SAFE_AI_KEY = 'test-key'
  const fx = makeFixture({ withFailure: false })
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return okResponse('端口占用解读')
  }
  const lines = []
  const written = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await cmdExplain(['--profile', 'web-copy', '--', '--port', '3084'], {
      spawn: (file, args) => {
        calls.push({ file, args })
        return { status: 1, stderr: 'Error: listen EADDRINUSE 3080\n' }
      },
      isTTY: true,
      log: (l) => lines.push(l),
      write: (l) => written.push(l),
    })
    assert.equal(code, 0)
    assert.deepEqual(calls[0].args, ['--profile', 'web-copy', '--port', '3084'])
    assert.equal(written[0], '端口占用解读')
  } finally {
    process.env.DSH_HOME = oldHome
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('explain：-- 透传但缺 --profile → 报错', async () => {
  process.env.DSH_SAFE_AI_KEY = 'test-key'
  const lines = []
  const code = await cmdExplain(['--', '--port', '3084'], { isTTY: true, log: (l) => lines.push(l), write: () => {} })
  assert.equal(code, 2)
  assert.ok(lines.some((l) => l.includes('需要与 --profile 一起使用')))
})

test('explain：--profile 现场试启失败 → 解读 stderr', async () => {
  process.env.DSH_SAFE_AI_KEY = 'test-key'
  const fx = makeFixture({ withFailure: false })
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return okResponse('解读')
  }
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await cmdExplain(['--profile', 'tui'], {
      spawn: (file, args) => {
        assert.equal(file, 'dsh')
        assert.deepEqual(args, ['--profile', 'tui'])
        return { status: 1, stderr: 'pending (waiting for services: webserver)\n' }
      },
      isTTY: true,
      log: (l) => lines.push(l),
      write: () => {},
    })
    assert.equal(code, 0)
    assert.ok(lines.some((l) => l.includes('正在试启 profile tui')))
    assert.equal(calls.length, 1)
  } finally {
    process.env.DSH_HOME = oldHome
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('explain：--profile 启动成功 → 无失败可解读，不调 AI', async () => {
  process.env.DSH_SAFE_AI_KEY = 'test-key'
  const fx = makeFixture({ withFailure: false })
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    let called = false
    const code = await cmdExplain(['--profile', 'web'], {
      spawn: () => {
        called = true
        return { status: 0, stderr: '' }
      },
      isTTY: true,
      log: (l) => lines.push(l),
      write: () => {},
    })
    assert.equal(code, 0)
    assert.equal(called, true)
    assert.ok(lines.some((l) => l.includes('能正常启动')))
  } finally {
    process.env.DSH_HOME = oldHome
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('explain：TTY 无失败记录 → 给出用法指引', async () => {
  process.env.DSH_SAFE_AI_KEY = 'test-key'
  const fx = makeFixture({ withFailure: false })
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await cmdExplain([], { isTTY: true, log: (l) => lines.push(l), write: () => {} })
    assert.equal(code, 2)
    assert.ok(lines.some((l) => l.includes('last-failure-<profile>.log')))
  } finally {
    process.env.DSH_HOME = oldHome
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('explain：AI 未启用 → 指引设置 key', async () => {
  delete process.env.DSH_SAFE_AI_KEY
  const lines = []
  const code = await cmdExplain(['--file', '/no/such/file'], { isTTY: true, log: (l) => lines.push(l), write: () => {} })
  assert.equal(code, 1)
  assert.ok(lines.some((l) => l.includes('DSH_SAFE_AI_KEY')))
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
