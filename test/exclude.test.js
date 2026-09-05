import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_SAFE_LANG = 'zh' // 本文件的 t() 断言固定中文（测试文件独立进程运行）

const { runWrapped } = await import('../lib/wrap.js')

const MANAGED_START = '# --- dsh-safe managed (auto-generated; do not edit) ---'
const FAIL_STDERR =
  'Error: dsh: plugin tree failed to load: dsh: plugin(s) failed to load: @acme/broken-plugin, @acme/other-broken; Cordis startup failed because these plugin(s) could not be resolved (see the error(s) logged above)\n'

/**
 * 两个坏插件（badplug / otherplug），豁免名单只放行其中一个的变体。
 * 豁免来源两种：config.json 的 exclude 与包装旗标 --exclude。
 */
function makeFixture({ exclude }) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-safe-exclude-'))
  const patchPath = join(home, 'profiles', 'web', 'cordis.patch.yml')
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  writeFileSync(patchPath, `- id: webserver\n  config:\n    port: 3080\n- id: badplug\n  name: '@acme/broken-plugin'\n- id: otherplug\n  name: '@acme/other-broken'\n`)
  if (exclude) {
    const dir = join(home, 'dsh-safe')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ exclude }, null, 2))
  }
  return { home, patchPath }
}

const makeSpawn = (scenarios) => {
  let attempt = 0
  return async () => {
    const s = scenarios[attempt++] ?? { code: 0 }
    return { code: s.code, stderr: s.stderr ?? '' }
  }
}

async function runOnce(fx, extra = {}) {
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await runWrapped({
      forwardArgs: ['web'],
      spawn: makeSpawn([
        { code: 1, stderr: FAIL_STDERR },
        { code: 1, stderr: FAIL_STDERR }, // 重试后仍失败（未豁免的行已禁用）→ 透传
      ]),
      log: (line) => lines.push(line),
      ...extra,
    })
    return { code, lines }
  } finally {
    process.env.DSH_HOME = oldHome
  }
}

test('豁免名单（config.json）：命中的行不隔离并提示，其余照常', async () => {
  const fx = makeFixture({ exclude: ['badplug'] })
  try {
    const { code, lines } = await runOnce(fx)
    assert.equal(code, 1)
    assert.ok(lines.some((l) => l.includes('按豁免名单跳过 @acme/broken-plugin')))
    const patch = readFileSync(fx.patchPath, 'utf8')
    assert.ok(/- id: otherplug\n  name: '@acme\/other-broken'\n  disabled: true/.test(patch)) // 未豁免的照常隔离
    assert.ok(!/- id: badplug\n  name: '@acme\/broken-plugin'\n  disabled: true/.test(patch)) // 豁免的没被动
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('豁免名单（--exclude 旗标）：等价生效', async () => {
  const fx = makeFixture({})
  try {
    const { code, lines } = await runOnce(fx, { exclude: ['@acme/broken-plugin'] }) // 按包名豁免
    assert.equal(code, 1)
    assert.ok(lines.some((l) => l.includes('按豁免名单跳过 @acme/broken-plugin')))
    const patch = readFileSync(fx.patchPath, 'utf8')
    assert.ok(/- id: otherplug\n  name: '@acme\/other-broken'\n  disabled: true/.test(patch))
    assert.ok(!/- id: badplug\n  name: '@acme\/broken-plugin'\n  disabled: true/.test(patch))
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})
