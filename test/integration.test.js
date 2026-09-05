import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BIN = join(ROOT, 'bin', 'dsh-safe.js')
const MANAGED_START = '# --- dsh-safe managed (auto-generated; do not edit) ---'

const FAIL_LIST_STDERR =
  'Error: dsh: plugin tree failed to load: dsh: plugin(s) failed to load: @acme/broken-plugin, @acme/another-broken; ' +
  'Cordis startup failed because these plugin(s) could not be resolved (see the error(s) logged above)\n' +
  '    at async boot (file:///opt/dsh/index.js:1491:13)\n'

const FAIL_FIRST_PARTY_STDERR =
  'Error: dsh: plugin tree failed to load: dsh: plugin(s) failed to load: @deepseek-ai/dsh-web-app; ' +
  'Cordis startup failed because these plugin(s) could not be resolved (see the error(s) logged above)\n'

/** 搭一个临时 DSH_HOME：web profile + 一个 bundle。返回 { home, patchPath, stateFile }。 */
function makeFixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-safe-test-'))
  const profileDir = join(home, 'profiles', 'web')
  const bundleDir = join(profileDir, 'node_modules', '@acme', 'broken-bundle')
  mkdirSync(join(bundleDir, 'node_modules'), { recursive: true })
  mkdirSync(join(home, 'bin'), { recursive: true })
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-web', private: true, dsh: { profile: { bundles: ['@acme/broken-bundle'] } } }, null, 2),
  )
  const patchPath = join(profileDir, 'cordis.patch.yml')
  writeFileSync(
    patchPath,
    `# 用户自己的注释，必须原样保留
- id: webserver
  config:
    port: 3080
- id: badplug
  name: '@acme/broken-plugin'
- id: webapp
  name: '@deepseek-ai/dsh-web-app'
`,
  )
  writeFileSync(
    join(bundleDir, 'package.json'),
    JSON.stringify({ name: '@acme/broken-bundle', dsh: { bundle: { patch: 'cordis.patch.yml' } } }),
  )
  writeFileSync(
    join(bundleDir, 'cordis.patch.yml'),
    `- insert:
    - id: bundleplug
      name: '@acme/another-broken'
`,
  )
  const stateFile = join(home, 'fake-dsh-attempts')
  return { home, patchPath, stateFile, profileDir }
}

/** 写一个假 dsh 可执行脚本：第 n 次运行按 scenarios[n-1] 输出并退出。 */
function makeFakeDsh(home, scenarios) {
  const binDir = join(home, 'bin')
  const script = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
const stateFile = process.env.FAKE_STATE
let n = 0
try { n = parseInt(readFileSync(stateFile, 'utf8').trim() || '0', 10) } catch {}
n += 1
writeFileSync(stateFile, String(n))
const scenarios = ${JSON.stringify(scenarios)}
const s = scenarios[n - 1] ?? { code: 0 }
if (s.stderr) process.stderr.write(s.stderr)
if (s.stdout) process.stdout.write(s.stdout)
process.exit(s.code ?? 0)
`
  const path = join(binDir, 'dsh')
  writeFileSync(path, script)
  chmodSync(path, 0o755)
  return path
}

function runSafe(home, args, extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_HOME: home,
      FAKE_STATE: join(home, 'fake-dsh-attempts'),
      PATH: `${join(home, 'bin')}:${process.env.PATH}`,
      DSH_SAFE_LANG: 'zh', // 固定语言，断言与宿主 locale 无关
      DSH_SAFE_NO_UPDATE_CHECK: '1', // 关闭新版提示，测试不依赖网络
      ...extraEnv,
    },
  })
}

const cleanup = (home) => rmSync(home, { recursive: true, force: true })

test('集成：启动失败 → 自动隔离两个坏插件 → 重试成功', () => {
  const fx = makeFixture()
  try {
    makeFakeDsh(fx.home, [
      { code: 1, stderr: FAIL_LIST_STDERR },
      { code: 0, stdout: 'web ready\n' },
    ])
    const result = runSafe(fx.home, ['web'])
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    // 重试确实发生了（假 dsh 跑了两轮）
    assert.equal(readFileSync(fx.stateFile, 'utf8').trim(), '2')
    const patch = readFileSync(fx.patchPath, 'utf8')
    // 用户内容原样保留
    assert.ok(patch.includes('# 用户自己的注释，必须原样保留'))
    assert.ok(patch.includes('- id: webserver'))
    assert.ok(patch.includes('port: 3080'))
    // 托管区块禁用了两个坏插件（bundle 行写入 profile patch）
    assert.ok(patch.includes(MANAGED_START))
    assert.ok(/- id: badplug[\s\S]*?disabled: true/.test(patch))
    assert.ok(/- id: bundleplug[\s\S]*?disabled: true/.test(patch))
    // 台账记录
    const ledger = JSON.parse(readFileSync(join(fx.home, 'dsh-safe', 'quarantine.json'), 'utf8'))
    assert.equal(ledger.profiles.web.length, 2)
    assert.ok(ledger.profiles.web.some((e) => e.id === 'bundleplug' && e.file === fx.patchPath))
  } finally {
    cleanup(fx.home)
  }
})

test('集成：第一方插件默认跳过，原样透传退出码', () => {
  const fx = makeFixture()
  try {
    makeFakeDsh(fx.home, [{ code: 1, stderr: FAIL_FIRST_PARTY_STDERR }])
    const result = runSafe(fx.home, ['web'])
    assert.equal(result.status, 1)
    assert.ok(result.stderr.includes('跳过第一方插件 @deepseek-ai/dsh-web-app'))
    const patch = readFileSync(fx.patchPath, 'utf8')
    assert.ok(!patch.includes(MANAGED_START))
    assert.ok(!existsSync(join(fx.home, 'dsh-safe', 'quarantine.json')))
  } finally {
    cleanup(fx.home)
  }
})

test('集成：识别不出的失败不写任何东西，不重试', () => {
  const fx = makeFixture()
  try {
    makeFakeDsh(fx.home, [{ code: 3, stderr: 'dsh: some unrelated crash\n' }])
    const result = runSafe(fx.home, ['web'])
    assert.equal(result.status, 3)
    assert.equal(readFileSync(fx.stateFile, 'utf8').trim(), '1')
    const patch = readFileSync(fx.patchPath, 'utf8')
    assert.ok(!patch.includes(MANAGED_START))
  } finally {
    cleanup(fx.home)
  }
})

test('集成：dry-run 只报告不落盘', () => {
  const fx = makeFixture()
  try {
    makeFakeDsh(fx.home, [{ code: 1, stderr: FAIL_LIST_STDERR }])
    const result = runSafe(fx.home, ['--dry-run', 'web'])
    assert.equal(result.status, 1)
    assert.ok(result.stderr.includes('（dry-run）将禁用'))
    const patch = readFileSync(fx.patchPath, 'utf8')
    assert.ok(!patch.includes(MANAGED_START))
  } finally {
    cleanup(fx.home)
  }
})

test('集成：max-retries 0 时不隔离不重试', () => {
  const fx = makeFixture()
  try {
    makeFakeDsh(fx.home, [{ code: 1, stderr: FAIL_LIST_STDERR }])
    const result = runSafe(fx.home, ['--max-retries', '0', 'web'])
    assert.equal(result.status, 1)
    assert.equal(readFileSync(fx.stateFile, 'utf8').trim(), '1')
    assert.ok(!readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START))
  } finally {
    cleanup(fx.home)
  }
})

test('集成：英文环境（DSH_SAFE_LANG=en）输出英文', () => {
  const fx = makeFixture()
  try {
    makeFakeDsh(fx.home, [
      { code: 1, stderr: FAIL_LIST_STDERR },
      { code: 1, stderr: FAIL_LIST_STDERR }, // 重试后仍失败：坏行已禁用 → 透传退出码 1
    ])
    const result = runSafe(fx.home, ['web'], { DSH_SAFE_LANG: 'en' })
    assert.equal(result.status, 1, `stderr: ${result.stderr}`)
    assert.equal(result.status, 1)
    assert.ok(result.stderr.includes('disabled @acme/broken-plugin'))
    assert.ok(result.stderr.includes('reason: '))
    assert.ok(!result.stderr.includes('已禁用'))
    const help = runSafe(fx.home, ['help'], { DSH_SAFE_LANG: 'en' })
    assert.ok(help.stdout.includes('startup fuse for dsh'))
  } finally {
    cleanup(fx.home)
  }
})

test('集成：重试仍失败 → 已禁用行（含 bundle 行）不重复隔离，透传退出码', () => {
  const fx = makeFixture()
  try {
    makeFakeDsh(fx.home, [
      { code: 1, stderr: FAIL_LIST_STDERR },
      { code: 1, stderr: FAIL_LIST_STDERR },
    ])
    const result = runSafe(fx.home, ['web'])
    assert.equal(result.status, 1, `stderr: ${result.stderr}`)
    // 恰好两轮 dsh：第二轮所有命中行已禁用，直接透传，不再重试第三次
    assert.equal(readFileSync(fx.stateFile, 'utf8').trim(), '2')
    // 台账没有因重复隔离而翻倍
    const ledger = JSON.parse(readFileSync(join(fx.home, 'dsh-safe', 'quarantine.json'), 'utf8'))
    assert.equal(ledger.profiles.web.length, 2)
    // 只有第一轮的两条禁用消息
    assert.equal(result.stderr.split('已禁用').length - 1, 2)
    assert.ok(result.stderr.includes('没有识别出'))
  } finally {
    cleanup(fx.home)
  }
})

test('集成：restore --all 摘除托管区块并清空台账', () => {
  const fx = makeFixture()
  try {
    makeFakeDsh(fx.home, [
      { code: 1, stderr: FAIL_LIST_STDERR },
      { code: 0 },
    ])
    assert.equal(runSafe(fx.home, ['web']).status, 0)
    assert.ok(readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START))

    const restore = runSafe(fx.home, ['restore', '--profile', 'web', '--all'])
    assert.equal(restore.status, 0, `stderr: ${restore.stderr}`)
    assert.ok(restore.stdout.includes('已恢复 @acme/broken-plugin'))
    const patch = readFileSync(fx.patchPath, 'utf8')
    assert.ok(!patch.includes(MANAGED_START))
    assert.ok(patch.includes('- id: badplug')) // 原始行还在，只是不再被禁用
    const ledger = JSON.parse(readFileSync(join(fx.home, 'dsh-safe', 'quarantine.json'), 'utf8'))
    assert.ok(!ledger.profiles?.web)
  } finally {
    cleanup(fx.home)
  }
})

test('集成：list 输出台账内容', () => {
  const fx = makeFixture()
  try {
    makeFakeDsh(fx.home, [
      { code: 1, stderr: FAIL_LIST_STDERR },
      { code: 0 },
    ])
    runSafe(fx.home, ['web'])
    const list = runSafe(fx.home, ['list', '--profile', 'web'])
    assert.equal(list.status, 0)
    assert.ok(list.stdout.includes('web:'))
    assert.ok(list.stdout.includes('@acme/broken-plugin'))
    assert.ok(list.stdout.includes('badplug'))
  } finally {
    cleanup(fx.home)
  }
})
