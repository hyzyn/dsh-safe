import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyManagedBlock, buildManagedBlock, MANAGED_START } from '../lib/patchfile.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BIN = join(ROOT, 'bin', 'dsh-safe.js')
const PKG = '@deepseek-ai/dsh'
const OLD_VERSION = '0.1.0'
const NEW_VERSION = '9.9.9'

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
  writeFileSync(dshBin, '#!/usr/bin/env node\nprocess.exit(0)\n')
  chmodSync(dshBin, 0o755)

  const binDir = join(home, 'bin')
  symlinkSync(dshBin, join(binDir, 'dsh'))

  // 假 npm：view 返回 FAKE_NPM_LATEST；install 记录参数并改写假 dsh 的版本
  const npmBin = join(binDir, 'npm')
  writeFileSync(
    npmBin,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_NPM_STATE, JSON.stringify(args) + '\\n')
if (args[0] === 'view') {
  console.log(process.env.FAKE_NPM_LATEST ?? '${NEW_VERSION}')
  process.exit(0)
}
if (args[0] === 'install') {
  const pkg = JSON.parse(readFileSync(process.env.FAKE_DSH_PKG_JSON, 'utf8'))
  pkg.version = args[2].split('@').pop()
  writeFileSync(process.env.FAKE_DSH_PKG_JSON, JSON.stringify(pkg, null, 2))
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

function runUpdate(fx, args, extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, 'update', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_HOME: fx.home,
      PATH: `${fx.binDir}:${process.env.PATH}`,
      DSH_SAFE_LANG: 'zh', // 固定语言，断言与宿主 locale 无关
      FAKE_NPM_STATE: join(fx.home, 'npm-calls'),
      FAKE_DSH_PKG_JSON: fx.pkgJsonPath,
      FAKE_NPM_LATEST: NEW_VERSION,
      ...extraEnv,
    },
  })
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
    // 假 npm 确实被调用：先 view 后 install
    const calls = readFileSync(join(fx.home, 'npm-calls'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(calls[0], ['view', PKG, 'version'])
    assert.deepEqual(calls[1], ['install', '-g', `${PKG}@${NEW_VERSION}`])
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
    const calls = readFileSync(join(fx.home, 'npm-calls'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(calls[0], ['install', '-g', `${PKG}@8.8.8`]) // --to 不查 latest，第一个调用就是 install
    assert.equal(JSON.parse(readFileSync(fx.pkgJsonPath, 'utf8')).version, '8.8.8')
    assert.ok(result.stderr.includes(`dsh 已更新: ${OLD_VERSION} → 8.8.8`))
  } finally {
    cleanup(fx.home)
  }
})
