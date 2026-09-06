import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyManagedBlock, buildManagedBlock, MANAGED_START } from '../lib/patchfile.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BIN = join(ROOT, 'bin', 'dsh-safe.js')

/** ledger 里 web profile 隔离了一个插件的 home。 */
function makeFixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-safe-cmds-'))
  const patchPath = join(home, 'profiles', 'web', 'cordis.patch.yml')
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  writeFileSync(patchPath, `- id: webserver\n  config:\n    port: 3080\n`)
  const entry = { id: 'badplug', name: '@acme/broken-plugin', reason: 'err', quarantinedAt: '2026-01-01T00:00:00.000Z', file: patchPath }
  writeFileSync(patchPath, applyManagedBlock(readFileSync(patchPath, 'utf8'), buildManagedBlock([entry])).text)
  const ledgerDir = join(home, 'dsh-safe')
  mkdirSync(ledgerDir, { recursive: true })
  writeFileSync(join(ledgerDir, 'quarantine.json'), JSON.stringify({ version: 1, profiles: { web: [entry] } }, null, 2))
  return { home, patchPath, ledgerPath: join(ledgerDir, 'quarantine.json') }
}

function runSafe(fx, args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_HOME: fx.home,
      DSH_SAFE_LANG: 'zh',
      DSH_SAFE_NO_UPDATE_CHECK: '1',
    },
  })
}

const cleanup = (home) => rmSync(home, { recursive: true, force: true })

test('list --json：输出结构化台账', () => {
  const fx = makeFixture()
  try {
    const result = runSafe(fx, ['list', '--json'])
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.version, 1)
    assert.equal(parsed.profiles.web[0].id, 'badplug')
    assert.equal(parsed.profiles.web[0].file, fx.patchPath)
  } finally {
    cleanup(fx.home)
  }
})

test('restore 省略 --profile：遍历台账全部 profile', () => {
  const fx = makeFixture()
  try {
    const result = runSafe(fx, ['restore', '--all'])
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    assert.ok(result.stdout.includes('已恢复 @acme/broken-plugin'))
    assert.ok(!readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START))
    assert.ok(!JSON.parse(readFileSync(fx.ledgerPath, 'utf8')).profiles?.web)
  } finally {
    cleanup(fx.home)
  }
})

test('doctor：汇总版本 / 台账 / patch 健康', () => {
  const fx = makeFixture()
  try {
    const result = runSafe(fx, ['doctor'])
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    assert.ok(result.stdout.includes('dsh-safe   0.5.0') || /dsh-safe   \d+\.\d+\.\d+/.test(result.stdout))
    assert.ok(result.stdout.includes('DSH_HOME'))
    assert.ok(result.stdout.includes('隔离台账    1 条'))
    assert.ok(result.stdout.includes('profiles   web'))
    assert.ok(result.stdout.includes('托管区块 ✓'))
    assert.ok(result.stdout.includes('AI         未启用'))
  } finally {
    cleanup(fx.home)
  }
})

/** 托管区块里禁了两个插件、台账却是空的（孤儿场景，如克隆 profile）。 */
function makeOrphanFixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-safe-orphan-'))
  const patchPath = join(home, 'profiles', 'web', 'cordis.patch.yml')
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  writeFileSync(patchPath, `- id: webserver\n  config:\n    port: 3080\n`)
  const entries = [
    { id: 'badplug', name: '@acme/broken-plugin', reason: 'err', quarantinedAt: '2026-01-01T00:00:00.000Z', file: patchPath },
    { id: 'otherplug', name: '@acme/other-broken', reason: 'err', quarantinedAt: '2026-01-01T00:00:00.000Z', file: patchPath },
  ]
  writeFileSync(patchPath, applyManagedBlock(readFileSync(patchPath, 'utf8'), buildManagedBlock(entries)).text)
  const ledgerDir = join(home, 'dsh-safe')
  mkdirSync(ledgerDir, { recursive: true })
  writeFileSync(join(ledgerDir, 'quarantine.json'), JSON.stringify({ version: 1, profiles: {} }, null, 2))
  return { home, patchPath, ledgerPath: join(ledgerDir, 'quarantine.json') }
}

test('list：孤儿禁用行可见（托管区块有、台账无）', () => {
  const fx = makeOrphanFixture()
  try {
    const result = runSafe(fx, ['list', '--profile', 'web'])
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    assert.ok(result.stdout.includes('孤儿禁用行'), `stdout: ${result.stdout}`)
    assert.ok(result.stdout.includes('badplug'))
    assert.ok(result.stdout.includes('dsh-safe restore --profile <名> --all'))
    const json = JSON.parse(runSafe(fx, ['list', '--json']).stdout)
    assert.deepEqual(json.orphans.web.map((o) => o.id), ['badplug', 'otherplug'])
  } finally {
    cleanup(fx.home)
  }
})

test('restore --all：摘除孤儿托管区块（台账无记录也生效）', () => {
  const fx = makeOrphanFixture()
  try {
    const result = runSafe(fx, ['restore', '--profile', 'web', '--all'])
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    assert.ok(result.stdout.includes('已摘除孤儿托管区块'), `stdout: ${result.stdout}`)
    assert.ok(!readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START))
    // 再跑一次：区块已没了 → noMatching
    const again = runSafe(fx, ['restore', '--profile', 'web', '--all'])
    assert.ok(again.stdout.includes('没有匹配的隔离记录'))
  } finally {
    cleanup(fx.home)
  }
})

test('restore --all --dry-run：孤儿区块只报告不摘除', () => {
  const fx = makeOrphanFixture()
  try {
    const result = runSafe(fx, ['restore', '--profile', 'web', '--all', '--dry-run'])
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    assert.ok(result.stdout.includes('（dry-run）将摘除孤儿托管区块'), `stdout: ${result.stdout}`)
    assert.ok(readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START))
  } finally {
    cleanup(fx.home)
  }
})
