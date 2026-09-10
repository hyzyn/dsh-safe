import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BIN = join(ROOT, 'bin', 'dsh-safe.js')
const MANAGED = 'dsh-safe managed'

/**
 * 现场复刻（0.15.0 实测事故）：webserver 因端口 3080 被另一个 dsh 实例占用而
 * apply 失败，依赖它提供的 webServer 服务的第三方插件只表现为 pending。旧行为会
 * 把 webserver 连同这些依赖方一起禁用——一次端口冲突永久禁用了 4 个插件。
 */
const ENV_STDERR = [
  'Error: dsh: plugin tree failed to load: dsh: 3 entries did not activate',
  '@linxin666/dsh-pet: pending (waiting for service: webServer)',
  'dsh-better-sidebar: pending (waiting for services: webServer, webRuntime)',
  '[cause]: Error: failed to apply loader entry webserver (@deepseek-ai/dsh-host-webserver): listen EADDRINUSE: address already in use 0.0.0.0:3080',
].join('\n')

// 同样的 pending 依赖，但没有任何环境类失败：这是真的等不到服务，应当隔离
const PLUGIN_STDERR = [
  'Error: dsh: plugin tree failed to load: dsh: 3 entries did not activate',
  '@linxin666/dsh-pet: pending (waiting for service: webServer)',
  'dsh-better-sidebar: pending (waiting for services: webServer, webRuntime)',
].join('\n')

/** fake dsh：固定输出一份 stderr 并以 1 退出，记录自己被调用了几次。 */
function makeFixture(stderr) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-safe-env-'))
  const binDir = join(home, 'bin')
  mkdirSync(binDir, { recursive: true })
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }))
  const patchPath = join(profileDir, 'cordis.patch.yml')
  writeFileSync(patchPath, "- id: pet\n  name: '@linxin666/dsh-pet'\n- id: better-sidebar\n  name: 'dsh-better-sidebar'\n")
  const dshBin = join(binDir, 'dsh')
  writeFileSync(
    dshBin,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.FAKE_DSH_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n')
process.stderr.write(${JSON.stringify(stderr)})
process.exit(1)
`,
  )
  chmodSync(dshBin, 0o755)
  return { home, binDir, patchPath }
}

function runSafe(fx) {
  return spawnSync(process.execPath, [BIN, '--max-retries', '2', '--profile', 'web'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_HOME: fx.home,
      PATH: `${fx.binDir}:${process.env.PATH}`,
      DSH_SAFE_LANG: 'zh',
      DSH_SAFE_NO_UPDATE_CHECK: '1', // 测试不依赖网络
      FAKE_DSH_CALLS: join(fx.home, 'calls'),
    },
  })
}

function callCount(fx) {
  try {
    return readFileSync(join(fx.home, 'calls'), 'utf8').trim().split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

const cleanup = (home) => rmSync(home, { recursive: true, force: true })

test('环境类失败（端口被占）：不隔离、不重试，透传退出码并说明原因', () => {
  const fx = makeFixture(ENV_STDERR)
  try {
    const result = runSafe(fx)
    assert.equal(result.status, 1, `stderr: ${result.stderr}`)
    assert.ok(result.stderr.includes('环境类失败，未隔离任何插件'))
    assert.ok(result.stderr.includes('EADDRINUSE'))
    assert.ok(result.stderr.includes('保持启用'))
    // 关键保证：patch 里没有托管区块，台账没有记录
    assert.ok(!readFileSync(fx.patchPath, 'utf8').includes(MANAGED))
    assert.ok(!existsSync(join(fx.home, 'dsh-safe', 'quarantine.json')))
    // 不隔离就不该重试：只启动一次
    assert.equal(callCount(fx), 1)
  } finally {
    cleanup(fx.home)
  }
})

test('环境类失败 + 第一方插件 pending：第一方保护之外的内容同样不被隔离', () => {
  const fx = makeFixture(
    [
      'Error: dsh: plugin tree failed to load: dsh: 4 entries did not activate',
      '@deepseek-ai/dsh-web-app: pending (waiting for service: webServer)',
      '@linxin666/dsh-pet: pending (waiting for service: webServer)',
      '[cause]: Error: failed to apply loader entry webserver (@deepseek-ai/dsh-host-webserver): listen EADDRINUSE: address already in use 0.0.0.0:3080',
    ].join('\n'),
  )
  try {
    const result = runSafe(fx)
    assert.equal(result.status, 1, `stderr: ${result.stderr}`)
    assert.ok(result.stderr.includes('环境类失败'))
    assert.ok(!readFileSync(fx.patchPath, 'utf8').includes(MANAGED))
    assert.ok(!existsSync(join(fx.home, 'dsh-safe', 'quarantine.json')))
  } finally {
    cleanup(fx.home)
  }
})

test('仅有 pending 依赖（无环境类失败）：照常隔离并重试，行为未被放宽', () => {
  const fx = makeFixture(PLUGIN_STDERR)
  try {
    const result = runSafe(fx)
    assert.equal(result.status, 1, `stderr: ${result.stderr}`)
    assert.ok(result.stderr.includes('已禁用'))
    assert.ok(!result.stderr.includes('环境类失败'))
    assert.ok(readFileSync(fx.patchPath, 'utf8').includes(MANAGED))
    assert.ok(callCount(fx) > 1) // 隔离后重试
  } finally {
    cleanup(fx.home)
  }
})
