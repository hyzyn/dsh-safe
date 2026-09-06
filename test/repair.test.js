import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_SAFE_LANG = 'zh' // 本文件的 t() 断言固定中文（测试文件独立进程运行）

const { cmdRepair } = await import('../lib/repair.js')
const { runWrapped } = await import('../lib/wrap.js')
const { applyManagedBlock, buildManagedBlock, MANAGED_START } = await import('../lib/patchfile.js')

const RESOLVE_REASON =
  "Error: failed to import loader entry badplug (@acme/broken-plugin): Cannot find package '@acme/broken-plugin'"
const CODE_REASON = 'TypeError: ctx.clientUi.registerModule is not a function'

/** ledger 里隔离了 badplug（可指定 reason 类型）+ 托管区块已写入。 */
function makeFixture(reason = RESOLVE_REASON, id = 'badplug', name = '@acme/broken-plugin') {
  const home = mkdtempSync(join(tmpdir(), 'dsh-safe-repair-'))
  const patchPath = join(home, 'profiles', 'web', 'cordis.patch.yml')
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  const entry = { id, name, reason, quarantinedAt: '2026-01-01T00:00:00.000Z', file: patchPath }
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

test('repair：省略 id 且只有一条记录 → 直接修它', async () => {
  const fx = makeFixture()
  const calls = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await cmdRepair(['-y'], {
      spawn: (file, args) => {
        calls.push({ file, args })
        return { status: 0 }
      },
      log: () => {},
      write: () => {},
    })
    assert.equal(code, 0)
    assert.deepEqual(calls[0].args, ['plugin', '--profile', 'web', 'add', '@acme/broken-plugin@latest'])
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})

test('repair：省略 id 且多条记录 → 列清单让用户挑，不执行', async () => {
  const fx = makeFixture()
  const other = { id: 'codeplug', name: '@acme/code-broken', reason: CODE_REASON, quarantinedAt: '2026-01-02T00:00:00.000Z', file: fx.patchPath }
  const ledgerPath = join(fx.home, 'dsh-safe', 'quarantine.json')
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
  ledger.profiles.web.push(other)
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2))
  writeFileSync(fx.patchPath, `- id: codeplug\n  name: '@acme/code-broken'\n  disabled: true\n`)

  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    let called = false
    const code = await cmdRepair([], {
      spawn: () => {
        called = true
        return { status: 0 }
      },
      log: (l) => lines.push(l),
      write: () => {},
    })
    assert.equal(code, 0)
    assert.ok(lines.some((l) => l.includes('共 2 条隔离记录')))
    assert.ok(lines.some((l) => l.includes('- badplug（@acme/broken-plugin）')))
    assert.ok(lines.some((l) => l.includes('- codeplug（@acme/code-broken）（不支持自动修复）')))
    assert.equal(called, false)
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})

test('repair：导出不匹配类（插件落后于 dsh API）→ 升级插件尝试适配', async () => {
  const EXPORT_REASON =
    "Error: failed to import loader entry badplug (@acme/broken-plugin): The requested module '@deepseek-ai/dsh-settings' does not provide an export named 'getSetting'"
  const fx = makeFixture(EXPORT_REASON)
  const calls = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await cmdRepair(['-y', 'badplug'], {
      spawn: (file, args) => {
        calls.push({ file, args })
        return { status: 0 }
      },
      log: () => {},
      write: () => {},
    })
    assert.equal(code, 0)
    assert.deepEqual(calls[0].args, ['plugin', '--profile', 'web', 'add', '@acme/broken-plugin@latest'])
    assert.ok(!readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START))
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})

test('repair：导出不匹配 + reason 被截断（真实场景）→ 仍可修复', async () => {
  const { summarizeLine } = await import('../lib/failures.js')
  // 真实案例原文（长 entry id + 长 scoped 包名），160 字符截断恰好切在
  // "does not provide an …"——"export" 一词被 … 吃掉
  const full =
    "Error: failed to import loader entry describe-image (@linxin666/dsh-tool-describe-image): The requested module '@deepseek-ai/dsh-settings' does not provide an export named 'getSetting'"
  const truncated = summarizeLine(full)
  assert.ok(truncated.endsWith('…'))
  assert.ok(truncated.includes('does not provide an '))
  assert.ok(!truncated.includes('does not provide an export'))

  const fx = makeFixture(truncated, 'describe-image', '@linxin666/dsh-tool-describe-image')
  const calls = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await cmdRepair(['-y', 'describe-image'], {
      spawn: (file, args) => {
        calls.push({ file, args })
        return { status: 0 }
      },
      log: () => {},
      write: () => {},
    })
    assert.equal(code, 0)
    assert.deepEqual(calls[0].args, ['plugin', '--profile', 'web', 'add', '@linxin666/dsh-tool-describe-image@latest'])
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})

test('repair：重复挂载类 → 拒接并给针对性指引', async () => {
  const DUP_REASON = 'TypeError: duplicate loader entry id: describe-image'
  const fx = makeFixture(DUP_REASON)
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
    assert.ok(lines.some((l) => l.includes('重装包无法修复')))
    assert.equal(called, false)
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})

test('wrap：duplicate 失败 → 不做无效隔离，给指引并透传', async () => {
  const fx = makeFixture()
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await runWrapped({
      forwardArgs: ['web'],
      spawn: async () => ({ code: 1, stderr: 'TypeError: duplicate loader entry id: describe-image\n' }),
      log: (l) => lines.push(l),
    })
    assert.equal(code, 1)
    assert.ok(lines.some((l) => l.includes('一键修复：dsh-safe repair describe-image')))
    assert.ok(lines.some((l) => l.includes('dsh-safe explain')))
    assert.ok(!lines.some((l) => l.includes('已禁用'))) // 不做无效的禁用+重试
    assert.ok(readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START)) // 原隔离状态原样保留
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})

/** duplicate 场景：manifest 挂了两个 bundle（web-ui-all 先声明），各自插入同 id。 */
function makeDupFixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-safe-dedupe-'))
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify(
      { name: 'dsh-profile-web', private: true, dsh: { profile: { bundles: ['@linxin666/dsh-web-ui-all', '@linxin666/dsh-tool-describe-image'] } } },
      null, 2,
    ),
  )
  for (const b of ['@linxin666/dsh-web-ui-all', '@linxin666/dsh-tool-describe-image']) {
    const dir = join(profileDir, 'node_modules', b)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: b, dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    writeFileSync(join(dir, 'cordis.patch.yml'), "- insert:\n    - id: describe-image\n      name: '@linxin666/dsh-tool-describe-image'\n")
  }
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const entry = {
    id: 'describe-image',
    name: '@linxin666/dsh-tool-describe-image',
    reason: 'TypeError: duplicate loader entry id: describe-image',
    quarantinedAt: '2026-01-01T00:00:00.000Z',
    file: patchPath,
  }
  writeFileSync(patchPath, `- id: webserver\n  config:\n    port: 3080\n`)
  writeFileSync(patchPath, applyManagedBlock(readFileSync(patchPath, 'utf8'), buildManagedBlock([entry])).text)
  const ledgerDir = join(home, 'dsh-safe')
  mkdirSync(ledgerDir, { recursive: true })
  writeFileSync(join(ledgerDir, 'quarantine.json'), JSON.stringify({ version: 1, profiles: { web: [entry] } }, null, 2))
  return { home, patchPath, manifestPath: join(profileDir, 'package.json'), ledgerPath: join(ledgerDir, 'quarantine.json') }
}

test('repair：duplicate 类 → 自动去重（-y 保留先声明来源，不安装）', async () => {
  const fx = makeDupFixture()
  const lines = []
  const written = []
  let spawnCalled = false
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await cmdRepair(['-y', 'describe-image'], {
      spawn: () => {
        spawnCalled = true
        return { status: 0 }
      },
      log: (l) => lines.push(l),
      write: (l) => written.push(l),
    })
    assert.equal(code, 0, `stderr: ${lines.join('\n')}`)
    // manifest：后声明的独立包已移除，聚合包保留
    const manifest = JSON.parse(readFileSync(fx.manifestPath, 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, ['@linxin666/dsh-web-ui-all'])
    // 无效禁用行已摘除：托管区块消失、台账清空
    assert.ok(!readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START))
    assert.ok(!JSON.parse(readFileSync(fx.ledgerPath, 'utf8')).profiles?.web)
    assert.ok(written.some((l) => l.includes('已恢复 @linxin666/dsh-tool-describe-image')))
    assert.ok(lines.some((l) => l.includes('去重完成')))
    assert.equal(spawnCalled, false) // 去重不需要安装
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})

test('repair：duplicate 类 --dry-run → 只展示去重方案', async () => {
  const fx = makeDupFixture()
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await cmdRepair(['--dry-run', 'describe-image'], {
      spawn: () => ({ status: 0 }),
      log: (l) => lines.push(l),
      write: () => {},
    })
    assert.equal(code, 0)
    assert.ok(lines.some((l) => l.includes('保留 @linxin666/dsh-web-ui-all 的挂载')))
    assert.ok(lines.some((l) => l.includes('dry-run')))
    const manifest = JSON.parse(readFileSync(fx.manifestPath, 'utf8'))
    assert.equal(manifest.dsh.profile.bundles.length, 2) // 未改动
  } finally {
    cleanup(fx.home)
  }
})

test('repair：安装路径修复后 → 自动去重多 bundle 冗余挂载（防复发）', async () => {
  const EXPORT_REASON =
    "Error: failed to import loader entry badplug (@acme/broken-plugin): The requested module '@deepseek-ai/dsh-settings' does not provide an export named 'getSetting'"
  const fx = makeFixture(EXPORT_REASON)
  // 聚合包也挂载同一插件：manifest 声明两个 bundle，各自插 badplug
  writeFileSync(
    join(fx.home, 'profiles', 'web', 'package.json'),
    JSON.stringify(
      { name: 'dsh-profile-web', private: true, dsh: { profile: { bundles: ['@acme/web-ui-all', '@acme/broken-plugin'] } } },
      null, 2,
    ),
  )
  for (const b of ['@acme/web-ui-all', '@acme/broken-plugin']) {
    const dir = join(fx.home, 'profiles', 'web', 'node_modules', b)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: b, dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    writeFileSync(join(dir, 'cordis.patch.yml'), "- insert:\n    - id: badplug\n      name: '@acme/broken-plugin'\n")
  }
  const manifestPath = join(fx.home, 'profiles', 'web', 'package.json')
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    let installCalls = 0
    const code = await cmdRepair(['-y', 'badplug'], {
      spawn: () => {
        installCalls++
        return { status: 0 }
      },
      log: (l) => lines.push(l),
      write: () => {},
    })
    assert.equal(code, 0)
    assert.equal(installCalls, 1) // 只安装一次
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, ['@acme/web-ui-all']) // 冗余来源已移除
    assert.ok(lines.some((l) => l.includes('去重完成') && l.includes('@acme/web-ui-all')))
    assert.ok(!readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START))
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})

test('repair --all：批量修复（跳过不支持的类别）', async () => {
  const fx = makeFixture()
  const ledgerPath = join(fx.home, 'dsh-safe', 'quarantine.json')
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
  ledger.profiles.web.push({
    id: 'codeplug', name: '@acme/code-broken', reason: CODE_REASON, quarantinedAt: '2026-01-02T00:00:00.000Z', file: fx.patchPath,
  })
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2))
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    let installCalls = 0
    const code = await cmdRepair(['-y', '--all'], {
      spawn: () => {
        installCalls++
        return { status: 0 }
      },
      log: (l) => lines.push(l),
      write: () => {},
    })
    assert.equal(code, 0)
    assert.equal(installCalls, 1) // 只有 badplug 可修复
    assert.ok(lines.some((l) => l.includes('将修复 1 条隔离记录: badplug')))
    assert.ok(lines.some((l) => l.includes('跳过 1 条（不支持自动修复）: codeplug')))
    assert.ok(lines.some((l) => l.includes('批量修复完成：成功 1 条，失败 0 条')))
    // badplug 已恢复移出台账；codeplug（不支持）保留
    const after = JSON.parse(readFileSync(ledgerPath, 'utf8')).profiles?.web ?? []
    assert.ok(!after.some((e) => e.id === 'badplug'))
    assert.ok(after.some((e) => e.id === 'codeplug'))
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})

test('repair --all --dry-run：逐条展示方案不执行', async () => {
  const fx = makeFixture()
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    let installCalls = 0
    const code = await cmdRepair(['--all', '--dry-run'], {
      spawn: () => {
        installCalls++
        return { status: 0 }
      },
      log: (l) => lines.push(l),
      write: () => {},
    })
    assert.equal(code, 0)
    assert.equal(installCalls, 0)
    assert.ok(lines.some((l) => l.includes('将修复 1 条隔离记录: badplug')))
    assert.ok(lines.some((l) => l.includes('dry-run')))
    assert.ok(readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START))
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})

test('repair：--all 与 id 同时使用 → 报错', async () => {
  const lines = []
  const code = await cmdRepair(['-y', '--all', 'badplug'], { spawn: () => ({ status: 0 }), log: (l) => lines.push(l), write: () => {} })
  assert.equal(code, 2)
  assert.ok(lines.some((l) => l.includes('不能同时使用')))
})

test('repair：台账无记录但被多 bundle 重复挂载 → 直接去重', async () => {
  const fx = makeDupFixture()
  // 模拟 duplicate 失败未入账（0.12.1 起 duplicate 不产生台账条目）
  writeFileSync(fx.ledgerPath, JSON.stringify({ version: 1, profiles: {} }, null, 2))
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await cmdRepair(['-y', 'describe-image', '--profile', 'web'], {
      spawn: () => ({ status: 0 }),
      log: (l) => lines.push(l),
      write: () => {},
    })
    assert.equal(code, 0)
    const manifest = JSON.parse(readFileSync(fx.manifestPath, 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, ['@linxin666/dsh-web-ui-all'])
    assert.ok(lines.some((l) => l.includes('去重完成')))
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

/** 清空台账与托管区块：模拟首次遇错（修复阶段无账可查）。 */
function emptyLedger(fx) {
  writeFileSync(fx.ledgerPath, JSON.stringify({ version: 1, profiles: {} }, null, 2))
  writeFileSync(fx.patchPath, `- id: webserver\n  config:\n    port: 3080\n`)
}

const DUP_STDERR = 'TypeError: duplicate loader entry id: describe-image\n'

test('wrap：duplicate 启动失败 → 自动去重后重试成功', async () => {
  const fx = makeDupFixture()
  emptyLedger(fx)
  let attempts = 0
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await runWrapped({
      forwardArgs: ['web'],
      spawn: async () => (++attempts === 1 ? { code: 1, stderr: DUP_STDERR } : { code: 0, stderr: '' }),
      log: (l) => lines.push(l),
    })
    assert.equal(code, 0)
    assert.equal(attempts, 2) // 去重后重试成功
    // 非交互保留先声明来源：聚合包留下，独立包从 bundles 移除
    const manifest = JSON.parse(readFileSync(fx.manifestPath, 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, ['@linxin666/dsh-web-ui-all'])
    assert.ok(lines.some((l) => l.includes('去重完成') && l.includes('@linxin666/dsh-web-ui-all')))
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})

test('wrap：duplicate 超过重试上限 → 指引并透传，不改 manifest', async () => {
  const fx = makeDupFixture()
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await runWrapped({
      forwardArgs: ['web'],
      maxRetries: 0,
      spawn: async () => ({ code: 1, stderr: DUP_STDERR }),
      log: (l) => lines.push(l),
    })
    assert.equal(code, 1)
    assert.ok(lines.some((l) => l.includes('已达最大重试次数')))
    assert.ok(lines.some((l) => l.includes('一键修复：dsh-safe repair describe-image')))
    const manifest = JSON.parse(readFileSync(fx.manifestPath, 'utf8'))
    assert.equal(manifest.dsh.profile.bundles.length, 2) // 未改动
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})

test('wrap：扫描器识别不了的 duplicate → 指引并透传', async () => {
  const fx = makeFixture()
  emptyLedger(fx)
  let attempts = 0
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await runWrapped({
      forwardArgs: ['web'],
      spawn: async () => {
        attempts++
        return { code: 1, stderr: 'TypeError: duplicate loader entry id: ghost\n' }
      },
      log: (l) => lines.push(l),
    })
    assert.equal(code, 1)
    assert.equal(attempts, 1) // 无可去重来源，不重试
    assert.ok(lines.some((l) => l.includes('一键修复：dsh-safe repair ghost')))
    assert.ok(lines.some((l) => l.includes('dsh-safe explain')))
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})

/** duplicate 场景（官方卷入）：bundles 可组合，各 bundle 都挂载官方 webserver 行。 */
function makeOfficialDupFixture(bundles) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-safe-dedupe-fp-'))
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-web', private: true, dsh: { profile: { bundles } } }, null, 2),
  )
  for (const b of bundles) {
    const dir = join(profileDir, 'node_modules', b)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: b, dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    writeFileSync(join(dir, 'cordis.patch.yml'), "- insert:\n    - id: webserver\n      name: '@deepseek-ai/dsh-host-webserver'\n")
  }
  return { home, manifestPath: join(profileDir, 'package.json') }
}

const DUP_WEBSERVER_STDERR = 'TypeError: duplicate loader entry id: webserver\n'

test('wrap：duplicate 涉官方 bundle → 非交互缺省保留官方来源（社区包先声明也不移除官方）', async () => {
  const fx = makeOfficialDupFixture(['@acme/web-ui-all', '@deepseek-ai/dsh-web-app'])
  let attempts = 0
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await runWrapped({
      forwardArgs: ['web'],
      spawn: async () => (++attempts === 1 ? { code: 1, stderr: DUP_WEBSERVER_STDERR } : { code: 0, stderr: '' }),
      log: (l) => lines.push(l),
    })
    assert.equal(code, 0)
    assert.equal(attempts, 2) // 去重后重试成功
    // 官方 bundle 保留，社区聚合包从 bundles 移除（旧逻辑会保留先声明的社区包）
    const manifest = JSON.parse(readFileSync(fx.manifestPath, 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-web-app'])
    assert.ok(lines.some((l) => l.includes('去重完成') && l.includes('@deepseek-ai/dsh-web-app')))
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})

test('wrap：duplicate 在两个官方 bundle 之间 → 默认拒绝去重，指引并透传', async () => {
  const fx = makeOfficialDupFixture(['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-base'])
  let attempts = 0
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await runWrapped({
      forwardArgs: ['web'],
      spawn: async () => {
        attempts++
        return { code: 1, stderr: DUP_WEBSERVER_STDERR }
      },
      log: (l) => lines.push(l),
    })
    assert.equal(code, 1)
    assert.equal(attempts, 1) // 拒绝去重，不重试
    assert.ok(lines.some((l) => l.includes('已跳过自动去重') && l.includes('@deepseek-ai/dsh-base')))
    assert.ok(lines.some((l) => l.includes('一键修复：dsh-safe repair webserver')))
    const manifest = JSON.parse(readFileSync(fx.manifestPath, 'utf8'))
    assert.equal(manifest.dsh.profile.bundles.length, 2) // 未改动
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})

test('wrap：duplicate 在两个官方 bundle 之间 → --allow-first-party 放行自动去重', async () => {
  const fx = makeOfficialDupFixture(['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-base'])
  let attempts = 0
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await runWrapped({
      forwardArgs: ['web'],
      allowFirstParty: true,
      spawn: async () => (++attempts === 1 ? { code: 1, stderr: DUP_WEBSERVER_STDERR } : { code: 0, stderr: '' }),
      log: () => {},
    })
    assert.equal(code, 0)
    assert.equal(attempts, 2)
    const manifest = JSON.parse(readFileSync(fx.manifestPath, 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-web-app']) // 保留先声明的官方来源
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})

test('repair：duplicate 涉官方 bundle → -y 非交互拒绝，不改 manifest 不安装', async () => {
  const fx = makeOfficialDupFixture(['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-base'])
  const lines = []
  let spawnCalled = false
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await cmdRepair(['-y', 'webserver', '--profile', 'web'], {
      spawn: () => {
        spawnCalled = true
        return { status: 0 }
      },
      log: (l) => lines.push(l),
      write: () => {},
    })
    assert.equal(code, 1)
    assert.equal(spawnCalled, false) // 去重被拒，不走到安装
    assert.ok(lines.some((l) => l.includes('已跳过自动去重') && l.includes('@deepseek-ai/dsh-base')))
    const manifest = JSON.parse(readFileSync(fx.manifestPath, 'utf8'))
    assert.equal(manifest.dsh.profile.bundles.length, 2) // 未改动
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})

test('wrap：台账非空启动 → 一行提醒', async () => {
  const fx = makeFixture() // badplug 在台账里（已禁用）
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await runWrapped({
      forwardArgs: ['web'],
      spawn: async () => ({ code: 0, stderr: '' }),
      log: (l) => lines.push(l),
    })
    assert.equal(code, 0)
    assert.ok(lines.some((l) => l.includes('处于自动禁用状态') && l.includes('dsh-safe list')))
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})

test('wrap：隔离重试成功后输出汇总（禁了谁、怎么修）', async () => {
  const fx = makeFixture() // badplug 已隔离；freshplug 是本次新增的失败
  writeFileSync(
    fx.patchPath,
    "- id: webserver\n  config:\n    port: 3080\n- id: badplug\n  name: '@acme/broken-plugin'\n  disabled: true\n- id: freshplug\n  name: '@acme/fresh-broken'\n",
  )
  let attempts = 0
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await runWrapped({
      forwardArgs: ['web'],
      spawn: async () =>
        ++attempts === 1
          ? { code: 1, stderr: "Error: failed to import loader entry freshplug (@acme/fresh-broken): Cannot find package '@acme/fresh-broken'\n" }
          : { code: 0, stderr: '' },
      log: (l) => lines.push(l),
    })
    assert.equal(code, 0)
    assert.equal(attempts, 2)
    assert.ok(lines.some((l) => l.includes('本次启动已自动禁用 1 个插件: @acme/fresh-broken')))
    assert.ok(lines.some((l) => l.includes('dsh-safe repair --all')))
    // freshplug 已入台账
    const after = JSON.parse(readFileSync(fx.ledgerPath, 'utf8')).profiles?.web ?? []
    assert.ok(after.some((e) => e.id === 'freshplug'))
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})

test('repair：长 id/包名把关键短语截断成 "does not p…" → 仍可修复（真实案例）', async () => {
  // 真实台账条目：160 字符截断切在 "does not p…"，连 "does not provide an" 都没保住
  const TRUNCATED_MID_PHRASE =
    "Error: failed to import loader entry ui-web-ui-settings (@linxin666/dsh-client-ui-web-ui-settings): The requested module '@deepseek-ai/dsh-settings' does not p…"
  const fx = makeFixture(TRUNCATED_MID_PHRASE, 'ui-web-ui-settings', '@linxin666/dsh-client-ui-web-ui-settings')
  const calls = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await cmdRepair(['-y', 'ui-web-ui-settings'], {
      spawn: (file, args) => {
        calls.push({ file, args })
        return { status: 0 }
      },
      log: () => {},
      write: () => {},
    })
    assert.equal(code, 0)
    assert.deepEqual(calls[0].args, [
      'plugin', '--profile', 'web', 'add', '@linxin666/dsh-client-ui-web-ui-settings@latest',
    ])
    assert.ok(!readFileSync(fx.patchPath, 'utf8').includes(MANAGED_START))
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})

test('repair --all：未入账 duplicate 预检（与包装启动的自愈对齐）', async () => {
  const fx = makeDupFixture()
  writeFileSync(fx.ledgerPath, JSON.stringify({ version: 1, profiles: {} }, null, 2))
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    let installCalls = 0
    const code = await cmdRepair(['-y', '--all'], {
      spawn: () => {
        installCalls++
        return { status: 0 }
      },
      log: (l) => lines.push(l),
      write: () => {},
    })
    assert.equal(code, 0)
    assert.equal(installCalls, 0) // 去重不需要安装
    const manifest = JSON.parse(readFileSync(fx.manifestPath, 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, ['@linxin666/dsh-web-ui-all'])
    assert.ok(lines.some((l) => l.includes('去重完成')))
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})

test('repair <id>：无 --profile 且台账无记录 → 跨 profile 预检去重', async () => {
  const fx = makeDupFixture()
  writeFileSync(fx.ledgerPath, JSON.stringify({ version: 1, profiles: {} }, null, 2))
  const lines = []
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = fx.home
  try {
    const code = await cmdRepair(['-y', 'describe-image'], {
      spawn: () => ({ status: 0 }),
      log: (l) => lines.push(l),
      write: () => {},
    })
    assert.equal(code, 0)
    const manifest = JSON.parse(readFileSync(fx.manifestPath, 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, ['@linxin666/dsh-web-ui-all'])
    assert.ok(lines.some((l) => l.includes('去重完成')))
  } finally {
    process.env.DSH_HOME = oldHome
    cleanup(fx.home)
  }
})
