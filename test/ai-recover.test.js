import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_SAFE_LANG = 'zh' // 本文件的 t() 断言固定中文（测试文件独立进程运行）

const { runWrapped } = await import('../lib/wrap.js')

const MANAGED_START = '# --- dsh-safe managed (auto-generated; do not edit) ---'
const CUSTOM_FAIL_STDERR = 'Error: totally custom boom involving @acme/broken-plugin (no known signature here)\n'

/**
 * AI 兜底在进程内测试（注入 detect 与 spawn）：沙箱/CI 环境对子进程网络
 * 有限制，CLI 级的 env → fetch 链路由 ai.test.js 的 fetch 桩覆盖。
 */
function makeFixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-safe-airecover-'))
  const patchPath = join(home, 'profiles', 'web', 'cordis.patch.yml')
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  writeFileSync(
    patchPath,
    `- id: badplug\n  name: '@acme/broken-plugin'\n- id: webapp\n  name: '@deepseek-ai/dsh-web-app'\n`,
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

test('AI 兜底：正则识别不出时，AI 挑出的坏插件仍走同一隔离管线', async () => {
  const fx = makeFixture()
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await runWrapped({
      forwardArgs: ['web'],
      detect: async () => [{ packageName: '@acme/broken-plugin', entryId: 'badplug', reason: 'custom boom' }],
      spawn: makeSpawn([
        { code: 1, stderr: CUSTOM_FAIL_STDERR },
        { code: 0 },
      ]),
      log: (line) => lines.push(line),
    })
    assert.equal(code, 0)
    assert.ok(lines.some((l) => l.includes('AI 兜底识别出 1 个可疑坏插件')))
    assert.ok(lines.some((l) => l.includes('原因: custom boom')))
    // 隔离生效：托管区块写入、重试成功
    const patch = readFileSync(fx.patchPath, 'utf8')
    assert.ok(patch.includes(MANAGED_START))
    assert.ok(/- id: badplug[\s\S]*?disabled: true/.test(patch))
  } finally {
    process.env.DSH_HOME = oldHome
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('AI 兜底：挑出的包不在真实行里 → 幻觉不落盘，原样透传', async () => {
  const fx = makeFixture()
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await runWrapped({
      forwardArgs: ['web'],
      detect: async () => [{ packageName: '@nope/invented' }],
      spawn: makeSpawn([
        { code: 1, stderr: CUSTOM_FAIL_STDERR },
        { code: 1, stderr: CUSTOM_FAIL_STDERR },
      ]),
      log: (line) => lines.push(line),
    })
    assert.equal(code, 1)
    assert.ok(!readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START))
    assert.ok(lines.some((l) => l.includes('没有识别出')))
  } finally {
    process.env.DSH_HOME = oldHome
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('AI 兜底：第一方保护同样约束 AI 结果', async () => {
  const fx = makeFixture()
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await runWrapped({
      forwardArgs: ['web'],
      detect: async () => [{ packageName: '@deepseek-ai/dsh-web-app' }],
      spawn: makeSpawn([{ code: 1, stderr: CUSTOM_FAIL_STDERR }]),
      log: (line) => lines.push(line),
    })
    assert.equal(code, 1)
    assert.ok(lines.some((l) => l.includes('跳过第一方插件 @deepseek-ai/dsh-web-app')))
    assert.ok(!readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START))
  } finally {
    process.env.DSH_HOME = oldHome
    rmSync(fx.home, { recursive: true, force: true })
  }
})
