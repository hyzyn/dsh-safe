import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

/** 写一个 fake dsh 可执行脚本：第 n 次运行按 scenarios[n-1] 输出并退出。 */
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

/**
 * 官方插件被 profile 覆盖行遮蔽的场景：bundle 层行带官方包名，profile 层覆盖行只写
 * config（无 name）。用 open-in-app 而非 webserver——后者已被"核心依赖"接管（永不自动
 * 禁用，见 dedupe.js），拿它测不到第一方名字回退这条链路。
 */
function makeOverriddenOfficialFixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-safe-webserver-'))
  const profileDir = join(home, 'profiles', 'web')
  const bundleDir = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-web-app')
  mkdirSync(bundleDir, { recursive: true })
  mkdirSync(join(home, 'bin'), { recursive: true })
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify(
      { name: 'dsh-profile-web', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } },
      null, 2,
    ),
  )
  const patchPath = join(profileDir, 'cordis.patch.yml')
  // 真实场景（profile 层只写覆盖 config）：覆盖行不重述 name，包名只存在于 bundle 层行
  writeFileSync(patchPath, `- id: open-in-app\n  config:\n    enabled: true\n`)
  writeFileSync(
    join(bundleDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-web-app', dsh: { bundle: { patch: 'cordis.patch.yml' } } }),
  )
  writeFileSync(
    join(bundleDir, 'cordis.patch.yml'),
    `- insert:\n    - id: open-in-app\n      name: '@deepseek-ai/dsh-host-open-in-app'\n`,
  )
  const stateFile = join(home, 'fake-dsh-attempts')
  return { home, patchPath, stateFile }
}

test('集成：启动失败 → 自动隔离两个坏插件 → 重试成功', () => {
  const fx = makeFixture()
  try {
    makeFakeDsh(fx.home, [
      { code: 1, stderr: FAIL_LIST_STDERR },
      { code: 0, stdout: 'web ready\n' },
    ])
    const result = runSafe(fx.home, ['web'])
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    // 重试确实发生了（fake dsh 跑了两轮）
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

test('集成：核心依赖（官方插件）默认跳过，原样透传退出码', () => {
  const fx = makeFixture()
  try {
    makeFakeDsh(fx.home, [{ code: 1, stderr: FAIL_FIRST_PARTY_STDERR }])
    const result = runSafe(fx.home, ['web'])
    assert.equal(result.status, 1)
    assert.ok(result.stderr.includes('跳过核心依赖 webapp'))
    const patch = readFileSync(fx.patchPath, 'utf8')
    assert.ok(!patch.includes(MANAGED_START))
    assert.ok(!existsSync(join(fx.home, 'dsh-safe', 'quarantine.json')))
  } finally {
    cleanup(fx.home)
  }
})

test('集成：官方插件被 profile 覆盖行（无 name）遮蔽 → 仍按包名识别第一方，不隔离', () => {
  const fx = makeOverriddenOfficialFixture()
  try {
    // 报错按 entry id 命中（reEntry / 外层栈），同 id 的 profile 覆盖行没有 name：
    // 包名必须从 bundle 层行回退取得，第一方保护才不会被覆盖行绕过
    makeFakeDsh(fx.home, [
      {
        code: 1,
        stderr:
          "Error: failed to import loader entry open-in-app (@deepseek-ai/dsh-host-open-in-app): Cannot find package '@deepseek-ai/dsh-host-open-in-app' imported from /Users/me/.dsh/profiles/web/cordis.patch.yml\n" +
          '    at Object.import (file:///opt/dsh/lib/loader.js:244:9)\n',
      },
    ])
    const result = runSafe(fx.home, ['web'])
    assert.equal(result.status, 1, `stderr: ${result.stderr}`)
    assert.ok(result.stderr.includes('跳过核心依赖 open-in-app'))
    assert.ok(!result.stderr.includes('已禁用'))
    assert.ok(!readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START))
    assert.ok(!existsSync(join(fx.home, 'dsh-safe', 'quarantine.json')))
  } finally {
    cleanup(fx.home)
  }
})

test('集成：官方 bundle 装在 dsh 安装目录下时也纳入对照表（收集缺口）', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-safe-dshinstall-'))
  try {
    const profileDir = join(home, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify({ name: 'dsh-profile-web', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }),
    )
    const patchPath = join(profileDir, 'cordis.patch.yml')
    writeFileSync(patchPath, "- id: gateway\n  config:\n    host: '0.0.0.0'\n")
    // 官方 bundle 只在 dsh 自己的安装目录下（profile/node_modules 里没有），且它声明的
    // 行没有 name：能认定 gateway 是核心依赖，只能靠收进来的这条 internal 行
    const dshPkgDir = join(home, 'global', 'node_modules', '@deepseek-ai', 'dsh')
    const officialBundleDir = join(dshPkgDir, 'node_modules', '@deepseek-ai', 'dsh-base')
    mkdirSync(join(dshPkgDir, 'lib'), { recursive: true })
    mkdirSync(officialBundleDir, { recursive: true })
    writeFileSync(join(dshPkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.2-rc.1' }))
    const dshBin = join(dshPkgDir, 'lib', 'bin.js')
    writeFileSync(
      dshBin,
      `#!/usr/bin/env node
process.stderr.write('Error: dsh: plugin tree failed to load: loader fibers failed\\n')
process.stderr.write('    at file:///Users/me/.dsh/profiles/web/#gateway\\n')
process.exit(1)
`,
    )
    chmodSync(dshBin, 0o755)
    mkdirSync(join(home, 'bin'), { recursive: true })
    symlinkSync(dshBin, join(home, 'bin', 'dsh'))
    writeFileSync(
      join(officialBundleDir, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh-base', dsh: { bundle: { patch: 'cordis.patch.yml' } } }),
    )
    writeFileSync(join(officialBundleDir, 'cordis.patch.yml'), '- insert:\n    - id: gateway\n      config: {}\n')

    const result = runSafe(home, ['web'])
    assert.equal(result.status, 1, `stderr: ${result.stderr}`)
    assert.ok(result.stderr.includes('跳过核心依赖 gateway'))
    assert.ok(!result.stderr.includes('已禁用'))
    assert.ok(!readFileSync(patchPath, 'utf8').includes(MANAGED_START))
    assert.ok(!existsSync(join(home, 'dsh-safe', 'quarantine.json')))
  } finally {
    cleanup(home)
  }
})

test('集成：官方 bundle 挂载的行即使没有 name 也不被禁用（结构信号）', () => {
  // 该 id 由官方 bundle 挂载，但任何层都没写 name，报错里也只有 entry id：
  // 只有"来源 bundle 是官方"这条不依赖名字解析的信号能兜住它
  const home = mkdtempSync(join(tmpdir(), 'dsh-safe-official-'))
  try {
    const profileDir = join(home, 'profiles', 'web')
    const bundleDir = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-base')
    mkdirSync(bundleDir, { recursive: true })
    mkdirSync(join(home, 'bin'), { recursive: true })
    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify({ name: 'dsh-profile-web', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }),
    )
    const patchPath = join(profileDir, 'cordis.patch.yml')
    writeFileSync(patchPath, "- id: gateway\n  config:\n    host: '0.0.0.0'\n")
    writeFileSync(
      join(bundleDir, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh-base', dsh: { bundle: { patch: 'cordis.patch.yml' } } }),
    )
    writeFileSync(join(bundleDir, 'cordis.patch.yml'), '- insert:\n    - id: gateway\n      config: {}\n')
    makeFakeDsh(home, [
      {
        code: 1,
        stderr:
          'Error: dsh: plugin tree failed to load: loader fibers failed\n' +
          '    at file:///Users/me/.dsh/profiles/web/#gateway\n',
      },
    ])
    const result = runSafe(home, ['web'])
    assert.equal(result.status, 1, `stderr: ${result.stderr}`)
    assert.ok(result.stderr.includes('跳过核心依赖 gateway'))
    assert.ok(!result.stderr.includes('已禁用'))
    assert.ok(!readFileSync(patchPath, 'utf8').includes(MANAGED_START))
    assert.ok(!existsSync(join(home, 'dsh-safe', 'quarantine.json')))
  } finally {
    cleanup(home)
  }
})

test('集成：无法确定包名的行按核心依赖对待，不隔离（fail closed）', () => {
  const fx = makeFixture()
  try {
    // 非官方来源、无 name、报错里也只有 entry id：无法证明它是普通第三方，
    // 就有可能是 dsh 的核心依赖——隔离是持久写入，宁可漏隔离也不误伤
    writeFileSync(fx.patchPath, `${readFileSync(fx.patchPath, 'utf8')}- id: mystery\n  config: {}\n`)
    makeFakeDsh(fx.home, [
      {
        code: 1,
        stderr:
          'Error: dsh: plugin tree failed to load: loader fibers failed\n' +
          '    at file:///Users/me/.dsh/profiles/web/#mystery\n',
      },
    ])
    const result = runSafe(fx.home, ['web'])
    assert.equal(result.status, 1, `stderr: ${result.stderr}`)
    assert.ok(result.stderr.includes('无法确定它属于哪个包'))
    assert.ok(!result.stderr.includes('已禁用'))
    assert.ok(!readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START))
    assert.ok(!existsSync(join(fx.home, 'dsh-safe', 'quarantine.json')))
  } finally {
    cleanup(fx.home)
  }
})

test('集成：webserver 是核心依赖——报错把包名说成第三方也禁不掉', () => {
  const fx = makeFixture()
  try {
    // 对抗场景：让解析出的包名是明确的第三方（名字信号在这里帮不上忙），
    // 只有"核心依赖"这层结构性能兜住 webserver
    makeFakeDsh(fx.home, [
      { code: 1, stderr: 'Error: failed to apply loader entry webserver (@acme/evil-plugin): boom\n' },
    ])
    const result = runSafe(fx.home, ['web'])
    assert.equal(result.status, 1, `stderr: ${result.stderr}`)
    assert.ok(result.stderr.includes('跳过核心依赖 webserver'))
    assert.ok(!result.stderr.includes('已禁用'))
    assert.ok(!readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START))
    assert.ok(!existsSync(join(fx.home, 'dsh-safe', 'quarantine.json')))
  } finally {
    cleanup(fx.home)
  }
})

test('集成：--allow-first-party 也放不开核心依赖 webserver', () => {
  const fx = makeFixture()
  try {
    makeFakeDsh(fx.home, [
      { code: 1, stderr: 'Error: failed to apply loader entry webserver (@deepseek-ai/dsh-host-webserver): boom\n' },
    ])
    const result = runSafe(fx.home, ['--allow-first-party', 'web'])
    assert.equal(result.status, 1, `stderr: ${result.stderr}`)
    assert.ok(result.stderr.includes('跳过核心依赖 webserver'))
    assert.ok(!result.stderr.includes('已禁用'))
    assert.ok(!existsSync(join(fx.home, 'dsh-safe', 'quarantine.json')))
  } finally {
    cleanup(fx.home)
  }
})

test('集成：加载器机制层（include / cordis:*）是核心依赖，禁不掉', () => {
  const fx = makeFixture()
  try {
    // 机制层行：树里真实存在该 id，但禁用它会拆掉 bundle 的挂载链路本身
    writeFileSync(fx.patchPath, `${readFileSync(fx.patchPath, 'utf8')}- id: include\n  config: {}\n`)
    makeFakeDsh(fx.home, [
      { code: 1, stderr: 'Error: failed to apply loader entry include (cordis:include): boom\n' },
    ])
    const result = runSafe(fx.home, ['web'])
    assert.equal(result.status, 1, `stderr: ${result.stderr}`)
    assert.ok(result.stderr.includes('跳过核心依赖 include'))
    assert.ok(!result.stderr.includes('已禁用'))
    assert.ok(!existsSync(join(fx.home, 'dsh-safe', 'quarantine.json')))
  } finally {
    cleanup(fx.home)
  }
})

test('集成：包名只存在于报错文本里时第一方保护仍生效（真机场景）', () => {
  const fx = makeFixture()
  try {
    // 真机复刻：覆盖行只写 config，且没有任何 bundle / home 层行声明该 id 的 name
    // ——包名只出现在 dsh 报错里。旧行为按 id 命中后 name=null，第一方保护
    // （@deepseek-ai/*）被绕过，官方插件被误禁（台账记成 name: null）。
    // 用 open-in-app 而非 webserver：后者已被核心依赖接管，测不到这条链路。
    writeFileSync(
      fx.patchPath,
      `${readFileSync(fx.patchPath, 'utf8')}- id: open-in-app\n  config:\n    enabled: true\n`,
    )
    makeFakeDsh(fx.home, [
      {
        code: 1,
        stderr: 'Error: failed to apply loader entry open-in-app (@deepseek-ai/dsh-host-open-in-app): some boom\n',
      },
    ])
    const result = runSafe(fx.home, ['web'])
    assert.equal(result.status, 1, `stderr: ${result.stderr}`)
    assert.ok(result.stderr.includes('跳过核心依赖 open-in-app'))
    assert.ok(!result.stderr.includes('已禁用'))
    assert.ok(!readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START))
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
