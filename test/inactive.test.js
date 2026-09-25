import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_SAFE_LANG = 'zh' // 本文件的 t() 断言固定中文（测试文件独立进程运行）

const { runWrapped } = await import('../lib/wrap.js')

const MANAGED_START = '# --- dsh-safe managed (auto-generated; do not edit) ---'

/** 宽容启动（dsh ≥ 0.1.6）：可选条目失败只告警，退出码 0。 */
const WARN_STDERR = [
  'dsh: warning: 1 entry did not activate',
  'badplug (@acme/broken-plugin): failed to import',
].join('\n')

/** 致命诊断（dsh ≥ 0.1.6）：required 条目 connection 挂了，可选条目 badplug 也挂了。 */
const FATAL_STDERR = [
  'dsh: startup failed: 1 required plugin did not activate',
  '',
  'Failed plugins (2):',
  '  badplug',
  '    Package: @acme/broken-plugin',
  '    Error: boom',
  '  connection (required)',
  '    Package: @deepseek-ai/dsh-client-connection',
  '    pending (waiting for services: webServer)',
  '',
].join('\n')

function makeFixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-safe-inactive-'))
  const patchPath = join(home, 'profiles', 'web', 'cordis.patch.yml')
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  writeFileSync(
    patchPath,
    "- id: webserver\n  config:\n    port: 3080\n- id: badplug\n  name: '@acme/broken-plugin'\n- id: connection\n  name: '@deepseek-ai/dsh-client-connection'\n",
  )
  return { home, patchPath }
}

const makeSpawn = (scenarios) => {
  let attempt = 0
  return async () => {
    const s = scenarios[attempt++] ?? { code: 0 }
    return { code: s.code, stderr: s.stderr ?? '' }
  }
}

async function runOnce(fx, scenarios, extra = {}) {
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await runWrapped({
      forwardArgs: ['web'],
      spawn: makeSpawn(scenarios),
      log: (line) => lines.push(line),
      ...extra,
    })
    return { code, lines }
  } finally {
    process.env.DSH_HOME = oldHome
  }
}

test('宽容启动（退出码 0 + 告警）：只读巡检列出未激活条目，patch 一个字节都不动', async () => {
  const fx = makeFixture()
  const before = readFileSync(fx.patchPath, 'utf8')
  try {
    const { code, lines } = await runOnce(fx, [{ code: 0, stderr: WARN_STDERR }])
    assert.equal(code, 0)
    assert.ok(lines.some((l) => l.includes('启动成功，但有 1 个插件未激活')))
    assert.ok(lines.some((l) => l.includes('badplug (@acme/broken-plugin): failed to import')))
    assert.ok(lines.some((l) => l.includes('未改动任何文件')))
    assert.equal(readFileSync(fx.patchPath, 'utf8'), before)
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('宽容启动但无未激活条目：不产生任何巡检噪音', async () => {
  const fx = makeFixture()
  try {
    const { code, lines } = await runOnce(fx, [{ code: 0, stderr: 'dsh: listening on http://localhost:3080\n' }])
    assert.equal(code, 0)
    assert.deepEqual(lines, [])
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('致命诊断：required 条目不被隔离（显式提示），可选条目照常隔离', async () => {
  const fx = makeFixture()
  try {
    // 第一次失败 → 隔离 badplug 后重试；第二次仍失败（connection 是 required，不会被禁用）
    const { code, lines } = await runOnce(fx, [
      { code: 1, stderr: FATAL_STDERR },
      { code: 1, stderr: FATAL_STDERR },
    ])
    assert.equal(code, 1)
    assert.ok(lines.some((l) => l.includes('跳过 required 条目 connection')))
    const patch = readFileSync(fx.patchPath, 'utf8')
    assert.ok(patch.includes(MANAGED_START))
    assert.ok(/- id: badplug\n  name: '@acme\/broken-plugin'\n  disabled: true/.test(patch)) // 可选条目被隔离
    assert.ok(!/- id: connection[\s\S]{0,120}disabled: true/.test(patch)) // required 条目没被动
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('--dry-run：宽容启动的巡检照常报告，但仍不写文件', async () => {
  const fx = makeFixture()
  const before = readFileSync(fx.patchPath, 'utf8')
  try {
    const { code, lines } = await runOnce(fx, [{ code: 0, stderr: WARN_STDERR }], { dryRun: true })
    assert.equal(code, 0)
    assert.ok(lines.some((l) => l.includes('未激活')))
    assert.equal(readFileSync(fx.patchPath, 'utf8'), before)
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('流式巡检：长驻进程运行中（stderr 分片到达）就报，且只报一次', async () => {
  const fx = makeFixture()
  try {
    const head = 'dsh: warning: 1 entry did not activate\n'
    const tail = 'badplug (@acme/broken-plugin): failed to import\n'
    const streamed = async (_args, opts) => {
      opts?.onStderr?.(head) // 只收到头部：声明 1 条、实际 0 条 → 不报
      opts?.onStderr?.(head + tail) // 收全 → 运行中报告
      return { code: 0, stderr: head + tail } // 退出兜底不得重复报
    }
    const lines = []
    const oldHome = process.env.DSH_HOME
    process.env.DSH_HOME = fx.home
    try {
      const code = await runWrapped({ forwardArgs: ['web'], spawn: streamed, log: (l) => lines.push(l) })
      assert.equal(code, 0)
    } finally {
      process.env.DSH_HOME = oldHome
    }
    assert.equal(lines.filter((l) => l.includes('未激活')).length, 1)
    assert.equal(lines.filter((l) => l.includes('badplug (@acme/broken-plugin)')).length, 1)
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})
