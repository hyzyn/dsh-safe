import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyManagedBlock, buildManagedBlock, MANAGED_START } from '../lib/patchfile.js'
import { isNewerVersion } from '../lib/update.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BIN = join(ROOT, 'bin', 'dsh-safe.js')
const PKG = '@deepseek-ai/dsh'
const OLD_VERSION = '0.1.0'
const NEW_VERSION = '9.9.9'
const SELF_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

/** 搭一个假环境：npm 全局目录里的 dsh 包 + 假 npm + 已隔离一个插件的 profile。 */
function makeFixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-safe-update-'))
  const globalDir = join(home, 'global')
  const pkgDir = join(globalDir, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(pkgDir, 'lib'), { recursive: true })
  mkdirSync(join(home, 'bin'), { recursive: true })
  const pkgJsonPath = join(pkgDir, 'package.json')
  writeFileSync(pkgJsonPath, JSON.stringify({ name: PKG, version: OLD_VERSION, bin: { dsh: 'lib/bin.js' } }))
  const dshBin = join(pkgDir, 'lib', 'bin.js')
  writeFileSync(
    dshBin,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
if (process.env.FAKE_DSH_CALLS) appendFileSync(process.env.FAKE_DSH_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n')
if (process.env.FAKE_DSH_STDOUT) process.stdout.write(process.env.FAKE_DSH_STDOUT)
process.exit(0)
`,
  )
  chmodSync(dshBin, 0o755)

  const binDir = join(home, 'bin')
  symlinkSync(dshBin, join(binDir, 'dsh'))

  // 假 npm：dsh 包的 view 返回 FAKE_NPM_LATEST；自身包返回 FAKE_NPM_SELF_LATEST
  //（缺省读真实 package.json → 自身视为最新）；install 只改写假 dsh 的版本
  const npmBin = join(binDir, 'npm')
  writeFileSync(
    npmBin,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_NPM_STATE, JSON.stringify(args) + '\\n')
if (args[0] === 'view') {
  if (process.env.FAKE_NPM_FAIL_VIEW === '1') process.exit(1)
  if (args[1] === '${PKG}') {
    console.log(process.env.FAKE_NPM_LATEST ?? '${NEW_VERSION}')
  } else {
    console.log(process.env.FAKE_NPM_SELF_LATEST ?? JSON.parse(readFileSync(process.env.FAKE_SELF_PKG_JSON, 'utf8')).version)
  }
  process.exit(0)
}
if (args[0] === 'install') {
  const spec = args.slice(2).find((s) => s.startsWith('${PKG}@'))
  if (spec) {
    const pkg = JSON.parse(readFileSync(process.env.FAKE_DSH_PKG_JSON, 'utf8'))
    pkg.version = spec.split('@').pop()
    writeFileSync(process.env.FAKE_DSH_PKG_JSON, JSON.stringify(pkg, null, 2))
  }
  process.exit(0)
}
process.exit(1)
`,
  )
  chmodSync(npmBin, 0o755)

  // profile：用户行 + 托管区块（隔离了 badplug）+ 台账
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const patchPath = join(profileDir, 'cordis.patch.yml')
  writeFileSync(
    patchPath,
    `# 用户自己的注释，必须原样保留
- id: webserver
  config:
    port: 3080
`,
  )
  const entry = { id: 'badplug', name: '@acme/broken-plugin', reason: 'err', quarantinedAt: '2026-01-01T00:00:00.000Z', file: patchPath }
  const ledgerDir = join(home, 'dsh-safe')
  mkdirSync(ledgerDir, { recursive: true })
  writeFileSync(
    join(ledgerDir, 'quarantine.json'),
    JSON.stringify({ version: 1, profiles: { web: [entry] } }, null, 2),
  )
  writeFileSync(patchPath, applyManagedBlock(readFileSync(patchPath, 'utf8'), buildManagedBlock([entry])).text)

  return { home, binDir, pkgJsonPath, patchPath, ledgerPath: join(ledgerDir, 'quarantine.json') }
}

const commonEnv = (fx) => ({
  DSH_HOME: fx.home,
  PATH: `${fx.binDir}:${process.env.PATH}`,
  DSH_SAFE_LANG: 'zh', // 固定语言，断言与宿主 locale 无关
  DSH_SAFE_NO_UPDATE_CHECK: '1', // 包装路径的新版提示不参与 update 测试
  FAKE_NPM_STATE: join(fx.home, 'npm-calls'),
  FAKE_DSH_PKG_JSON: fx.pkgJsonPath,
  FAKE_SELF_PKG_JSON: join(ROOT, 'package.json'),
  FAKE_NPM_LATEST: NEW_VERSION,
  FAKE_DSH_CALLS: join(fx.home, 'dsh-calls'),
  FAKE_DSH_STDOUT: 'dsh booted\n',
})

function runUpdate(fx, args, extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, 'update', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...commonEnv(fx), ...extraEnv },
  })
}

function runU(fx, args, extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...commonEnv(fx), ...extraEnv },
  })
}

/** 读假进程的调用记录；文件不存在（没被调用）返回 []。 */
function readCalls(fx, name) {
  try {
    return readFileSync(join(fx.home, name), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

const cleanup = (home) => rmSync(home, { recursive: true, force: true })

test('update：升级 → 自动恢复隔离 → 提示回滚', async () => {
  const fx = makeFixture()
  try {
    const result = runUpdate(fx, ['-y'])
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    // 计划与安装命令
    assert.ok(result.stderr.includes(`dsh ${PKG} ${OLD_VERSION} → ${NEW_VERSION} (npm)`))
    assert.ok(result.stderr.includes(`npm install -g ${PKG}@${NEW_VERSION}`))
    // 假 npm 确实被调用：view dsh → view 自身 → install
    const calls = readFileSync(join(fx.home, 'npm-calls'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(calls[0], ['view', PKG, 'version'])
    assert.deepEqual(calls[1], ['view', '@hyzyn/dsh-safe', 'version'])
    assert.deepEqual(calls[2], ['install', '-g', `${PKG}@${NEW_VERSION}`])
    // 假 dsh 版本已被"升级"
    assert.equal(JSON.parse(readFileSync(fx.pkgJsonPath, 'utf8')).version, NEW_VERSION)
    // 隔离插件已恢复：托管区块摘除、台账清空
    assert.ok(!readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START))
    assert.ok(readFileSync(fx.patchPath, 'utf8').includes('# 用户自己的注释，必须原样保留'))
    assert.ok(!JSON.parse(readFileSync(fx.ledgerPath, 'utf8')).profiles?.web)
    assert.ok(result.stdout.includes('已恢复 1 个被隔离的插件 (profile: web)'))
    // 验证与回滚提示
    assert.ok(result.stderr.includes(`dsh 已更新: ${OLD_VERSION} → ${NEW_VERSION}`))
    assert.ok(result.stderr.includes('仍不兼容的插件会自动再次隔离'))
    assert.ok(result.stderr.includes(`update --to ${OLD_VERSION}`))
  } finally {
    cleanup(fx.home)
  }
})

test('update：已是最新版本时不安装不恢复', async () => {
  const fx = makeFixture()
  try {
    const result = runUpdate(fx, ['-y'], { FAKE_NPM_LATEST: OLD_VERSION })
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    assert.ok(result.stderr.includes('无需更新'))
    const calls = readFileSync(join(fx.home, 'npm-calls'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.ok(!calls.some((c) => c[0] === 'install'))
    assert.ok(readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START)) // 隔离状态未动
  } finally {
    cleanup(fx.home)
  }
})

test('update：非交互环境缺 -y 时拒绝执行', async () => {
  const fx = makeFixture()
  try {
    const result = runUpdate(fx, [])
    assert.equal(result.status, 1)
    assert.ok(result.stderr.includes('不是交互终端'))
    const calls = readFileSync(join(fx.home, 'npm-calls'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.ok(!calls.some((c) => c[0] === 'install'))
  } finally {
    cleanup(fx.home)
  }
})

test('update：--to 指定目标版本（兼作回滚）', async () => {
  const fx = makeFixture()
  try {
    const result = runUpdate(fx, ['-y', '--to', '8.8.8'])
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    const calls = readCalls(fx, 'npm-calls')
    assert.deepEqual(calls[0], ['install', '-g', `${PKG}@8.8.8`]) // --to 不查 latest，第一个调用就是 install
    assert.equal(JSON.parse(readFileSync(fx.pkgJsonPath, 'utf8')).version, '8.8.8')
    assert.ok(result.stderr.includes(`dsh 已更新: ${OLD_VERSION} → 8.8.8`))
  } finally {
    cleanup(fx.home)
  }
})

test('update：--self 只更新 dsh-safe 自身，不动 dsh 与隔离状态', async () => {
  const fx = makeFixture()
  try {
    const result = runUpdate(fx, ['-y', '--self'], { FAKE_NPM_SELF_LATEST: '9.9.9' })
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    const calls = readCalls(fx, 'npm-calls')
    assert.deepEqual(calls[0], ['view', '@hyzyn/dsh-safe', 'version']) // --self 不查 dsh
    assert.deepEqual(calls[1], ['install', '-g', '@hyzyn/dsh-safe@9.9.9'])
    assert.ok(result.stderr.includes(`dsh-safe 已更新: ${SELF_VERSION} → 9.9.9`))
    assert.ok(result.stderr.includes('下次启动生效'))
    assert.ok(readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START)) // 隔离状态未动
  } finally {
    cleanup(fx.home)
  }
})

test('update：dsh 与 dsh-safe 都有更新 → 一条命令一起装，恢复隔离', async () => {
  const fx = makeFixture()
  try {
    const result = runUpdate(fx, ['-y'], { FAKE_NPM_SELF_LATEST: '8.8.8' })
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    assert.ok(result.stderr.includes(`dsh ${PKG} ${OLD_VERSION} → ${NEW_VERSION} (npm)`))
    assert.ok(result.stderr.includes(`dsh-safe @hyzyn/dsh-safe ${SELF_VERSION} → 8.8.8 (npm)`))
    const calls = readCalls(fx, 'npm-calls')
    assert.deepEqual(calls[2], ['install', '-g', `${PKG}@${NEW_VERSION}`, '@hyzyn/dsh-safe@8.8.8'])
    assert.ok(result.stderr.includes(`dsh 已更新: ${OLD_VERSION} → ${NEW_VERSION}`))
    assert.ok(result.stderr.includes(`dsh-safe 已更新: ${SELF_VERSION} → 8.8.8`))
    assert.ok(!readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START)) // dsh 更新触发了恢复
  } finally {
    cleanup(fx.home)
  }
})

test('notify：包装启动时提示 dsh-safe 新版，每天最多一次', async () => {
  const fx = makeFixture()
  try {
    const first = runU(fx, ['web'], { FAKE_NPM_LATEST: OLD_VERSION, FAKE_NPM_SELF_LATEST: NEW_VERSION, DSH_SAFE_NO_UPDATE_CHECK: '' })
    assert.equal(first.status, 0, `stderr: ${first.stderr}`)
    assert.ok(first.stderr.includes(`dsh-safe 有新版本 ${NEW_VERSION}（当前 ${SELF_VERSION}）`))
    assert.ok(first.stderr.includes('update --self'))
    assert.deepEqual(readCalls(fx, 'dsh-calls'), [['web']]) // 提示不影响启动
    // 时间戳缓存已写入
    assert.ok(JSON.parse(readFileSync(join(fx.home, 'dsh-safe', 'update-check.json'), 'utf8')).lastCheckAt)
    // 第二次启动：缓存生效，不再提示
    const second = runU(fx, ['web'], { FAKE_NPM_LATEST: OLD_VERSION, FAKE_NPM_SELF_LATEST: NEW_VERSION, DSH_SAFE_NO_UPDATE_CHECK: '' })
    assert.equal(second.status, 0, `stderr: ${second.stderr}`)
    assert.ok(!second.stderr.includes('有新版本'))
    assert.deepEqual(readCalls(fx, 'dsh-calls'), [['web'], ['web']])
  } finally {
    cleanup(fx.home)
  }
})

test('isNewerVersion：语义化版本比较', () => {
  assert.equal(isNewerVersion('0.4.0', '0.3.0'), true)
  assert.equal(isNewerVersion('0.2.0', '0.3.0'), false) // registry 落后于本地开发版 → 不自降级
  assert.equal(isNewerVersion('0.3.0', '0.3.0'), false)
  assert.equal(isNewerVersion('1.0.0', '0.9.9'), true)
  assert.equal(isNewerVersion('0.1.2', '0.1.2-rc.1'), true) // 正式版 > 预发布
  assert.equal(isNewerVersion('0.1.2-rc.2', '0.1.2-rc.1'), true)
  assert.equal(isNewerVersion('0.1.2-rc.1', '0.1.2'), false)
})

test('update：registry 版本低于本地时自身不降级', async () => {
  const fx = makeFixture()
  try {
    const result = runUpdate(fx, ['-y'], { FAKE_NPM_SELF_LATEST: '0.0.9' })
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    const calls = readCalls(fx, 'npm-calls')
    assert.deepEqual(calls[2], ['install', '-g', `${PKG}@${NEW_VERSION}`]) // 只有 dsh 入计划
    assert.ok(!result.stderr.includes('dsh-safe 已更新'))
  } finally {
    cleanup(fx.home)
  }
})

test('-u web：已最新 → 静默跳过升级直接启动', async () => {
  const fx = makeFixture()
  try {
    const result = runU(fx, ['-u', 'web'], { FAKE_NPM_LATEST: OLD_VERSION })
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    assert.ok(!result.stderr.includes('无需更新')) // 日常启动的快路径不刷屏
    assert.ok(result.stdout.includes('dsh booted'))
    assert.deepEqual(readCalls(fx, 'dsh-calls'), [['web']])
    assert.ok(!readCalls(fx, 'npm-calls').some((c) => c[0] === 'install'))
  } finally {
    cleanup(fx.home)
  }
})

test('-u -y web：有更新 → 升级并恢复隔离再启动', async () => {
  const fx = makeFixture()
  try {
    const result = runU(fx, ['-u', '-y', 'web'])
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    assert.ok(result.stderr.includes(`dsh 已更新: ${OLD_VERSION} → ${NEW_VERSION}`))
    assert.ok(result.stdout.includes('已恢复 1 个被隔离的插件 (profile: web)'))
    assert.ok(!readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START))
    assert.deepEqual(readCalls(fx, 'dsh-calls'), [['web']])
  } finally {
    cleanup(fx.home)
  }
})

test('-u web：更新检查失败 → 告警并照常启动', async () => {
  const fx = makeFixture()
  try {
    const result = runU(fx, ['-u', 'web'], { FAKE_NPM_FAIL_VIEW: '1' })
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    assert.ok(result.stderr.includes('跳过升级直接启动'))
    assert.ok(result.stdout.includes('dsh booted'))
    assert.deepEqual(readCalls(fx, 'dsh-calls'), [['web']])
  } finally {
    cleanup(fx.home)
  }
})

test('-u web：非交互且有更新 → 拒绝不启动', async () => {
  const fx = makeFixture()
  try {
    const result = runU(fx, ['-u', 'web'])
    assert.equal(result.status, 1)
    assert.ok(result.stderr.includes('不是交互终端'))
    assert.deepEqual(readCalls(fx, 'dsh-calls'), [])
    assert.ok(!readCalls(fx, 'npm-calls').some((c) => c[0] === 'install'))
  } finally {
    cleanup(fx.home)
  }
})
