import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_SAFE_LANG = 'zh' // 本文件的 t() 断言固定中文（测试文件独立进程运行）

const { cmdRepair } = await import('../lib/repair.js')
const { applyManagedBlock, buildManagedBlock, MANAGED_START } = await import('../lib/patchfile.js')

const RESOLVE_REASON =
  "Error: failed to import loader entry badplug (@acme/broken-plugin): Cannot find package '@acme/broken-plugin'"
const CODE_REASON = 'TypeError: ctx.clientUi.registerModule is not a function'

/** ledger 里隔离了 badplug（可指定 reason 类型）+ 托管区块已写入。 */
function makeFixture(reason = RESOLVE_REASON) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-safe-repair-'))
  const patchPath = join(home, 'profiles', 'web', 'cordis.patch.yml')
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  const entry = { id: 'badplug', name: '@acme/broken-plugin', reason, quarantinedAt: '2026-01-01T00:00:00.000Z', file: patchPath }
  writeFileSync(patchPath, `- id: webserver\n  config:\n    port: 3080\n`)
  writeFileSync(patchPath, applyManagedBlock(readFileSync(patchPath, 'utf8'), buildManagedBlock([entry])).text)
  const ledgerDir = join(home, 'dsh-safe')
  mkdirSync(ledgerDir, { recursive: true })
  writeFileSync(
    join(ledgerDir, 'quarantine.json'),
    JSON.stringify({ version: 1, profiles: { web: [entry] } }, null, 2),
  )
  return { home, patchPath, ledgerPath: join(ledgerDir, 'quarantine.json') }
}

const cleanup = (home) => rmSync(home, { recursive: true, force: true })

test('repair：解析失败类 → 经 dsh plugin 安装后自动恢复', async () => {
  const fx = makeFixture()
  const calls = []
  const lines = []
  const written = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await cmdRepair(['-y', 'badplug'], {
      spawn: (file, args) => {
        calls.push({ file, args })
        return { status: 0 }
      },
      log: (l) => lines.push(l),
      write: (l) => written.push(l),
    })
    assert.equal(code, 0)
    // 安装走 dsh plugin 的 pnpm 转发通道，目标版本默认 latest
    assert.equal(calls.length, 1)
    assert.equal(calls[0].file, 'dsh')
    assert.deepEqual(calls[0].args, ['plugin', '--profile', 'web', 'add', '@acme/broken-plugin@latest'])
    // 隔离行已恢复：托管区块摘除、台账清空
    assert.ok(!readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START))
    assert.ok(!JSON.parse(readFileSync(fx.ledgerPath, 'utf8')).profiles?.web)
    assert.ok(written.some((l) => l.includes('已恢复 @acme/broken-plugin')))
    assert.ok(lines.some((l) => l.includes('修复完成')))
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})

test('repair：非解析失败类（代码错误）→ 拒接且不执行安装', async () => {
  const fx = makeFixture(CODE_REASON)
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    let called = false
    const code = await cmdRepair(['-y', 'badplug'], {
      spawn: () => {
        called = true
        return { status: 0 }
      },
      log: (l) => lines.push(l),
      write: () => {},
    })
    assert.equal(code, 1)
    assert.ok(lines.some((l) => l.includes('不支持自动修复') && l.includes('TypeError')))
    assert.equal(called, false)
    assert.ok(readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START)) // 隔离状态未动
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})

test('repair：安装失败 → 保持隔离状态不变，退出码透传', async () => {
  const fx = makeFixture()
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await cmdRepair(['-y', 'badplug'], {
      spawn: () => ({ status: 3 }),
      log: (l) => lines.push(l),
      write: () => {},
    })
    assert.equal(code, 3)
    assert.ok(lines.some((l) => l.includes('安装失败') && l.includes('隔离状态保持不变')))
    assert.ok(readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START))
    assert.ok(JSON.parse(readFileSync(fx.ledgerPath, 'utf8')).profiles?.web)
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})

test('repair：--dry-run 只展示计划不执行；--to 指定版本', async () => {
  const fx = makeFixture()
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    let called = false
    const code = await cmdRepair(['--dry-run', '--to', '1.2.3', 'badplug'], {
      spawn: () => {
        called = true
        return { status: 0 }
      },
      log: (l) => lines.push(l),
      write: () => {},
    })
    assert.equal(code, 0)
    assert.equal(called, false)
    assert.ok(lines.some((l) => l.includes('将在 profile web 中修复 @acme/broken-plugin')))
    assert.ok(lines.some((l) => l.includes('dsh plugin --profile web add @acme/broken-plugin@1.2.3')))
    assert.ok(lines.some((l) => l.includes('dry-run')))
    assert.ok(readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START))
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})

test('repair：台账里没有该 id → 报错', async () => {
  const fx = makeFixture()
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await cmdRepair(['-y', 'nope'], { spawn: () => ({ status: 0 }), log: (l) => lines.push(l), write: () => {} })
    assert.equal(code, 1)
    assert.ok(lines.some((l) => l.includes('没有找到 nope')))
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})
