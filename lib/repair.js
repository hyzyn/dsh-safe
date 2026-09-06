/**
 * @hyzyn/dsh-safe — `dsh-safe repair <id>`：半自动修复被隔离的插件。
 *
 * 只处理"模块解析失败"类（Cannot find package / could not be resolved /
 * ERR_MODULE_NOT_FOUND）——这类问题重装/升级插件包即可修复。其它类型
 * （apply 抛错、pending 服务等待等）属于代码或配置问题，明确拒接。
 *
 * 流程：台账定位条目 → 类别门禁 → 展示计划 → 确认 → 经 `dsh plugin add`
 * （dsh 官方的 pnpm 转发通道）安装 → 自动摘除隔离行。不内置启动：装好后
 * 由用户跑 dsh-safe 验证，再失败会自动回到隔离管线。安装失败则保持隔离
 * 状态不变，退出码透传。
 */
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { loadLedger, restoreQuarantine } from './quarantine.js'
import { summarizeLine } from './failures.js'
import { profileManifestPath, readIfExists, resolveDshSpawnTarget } from './dshpaths.js'
import { collectKnownRows } from './knownrows.js'
import { t } from './i18n.js'

const err = (line) => process.stderr.write(`${line}\n`)
const out = (line) => process.stdout.write(`${line}\n`)

/**
 * repair 可修复的失败特征：问题出在"包的安装状态或版本适配"上，重装/升级
 * 插件包可能修复——
 *   - 模块解析失败：包缺失/损坏/未安装 → 重装即愈；
 *   - ESM 导出不匹配（does not provide an [export|import binding]）：插件与
 *     当前 dsh API 版本不兼容，升级插件到适配版本可能修复（真实案例：
 *     describe-image 隔离于 dsh-settings 导出变更）。修复失败不恢复、无损。
 * 注意：台账 reason 经 summarizeLine 截断过（160 字符），关键短语可能被
 * "…" 切断，因此导出不匹配的特征只匹配到 "does not provide an" 为止。
 */
const REPAIRABLE_RE =
  /Cannot find package|could not be resolved|ERR_MODULE_NOT_FOUND|does not provide an( (?:export|import binding))?/i

function parseRepairArgs(args) {
  const opts = { id: undefined, profile: undefined, to: undefined, yes: false, dryRun: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-y' || a === '--yes') opts.yes = true
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--profile') {
      const v = args[++i]
      if (v === undefined) return { error: { key: 'updateUnknownFlag', params: { arg: '--profile' } } }
      opts.profile = v
    } else if (a.startsWith('--profile=')) opts.profile = a.slice('--profile='.length)
    else if (a === '--to') {
      const v = args[++i]
      if (v === undefined) return { error: { key: 'updateUnknownFlag', params: { arg: '--to' } } }
      opts.to = v
    } else if (a.startsWith('--to=')) opts.to = a.slice('--to='.length)
    else if (!a.startsWith('-') && opts.id === undefined) opts.id = a
    else return { error: { key: 'updateUnknownFlag', params: { arg: a } } }
  }
  if (opts.to !== undefined && !/^[\w.+-]+$/.test(opts.to)) return { error: { key: 'updateToInvalid' } }
  return { opts }
}

/**
 * @param {string[]} args
 * @param {{
 *   spawn?: typeof spawnSync,
 *   log?: (line: string) => void,
 *   write?: (line: string) => void,
 * }} [hooks] spawn/log/write 可注入（测试）
 * @returns {Promise<number>} 退出码
 */
export async function cmdRepair(args, { spawn = spawnSync, log = err, write = out } = {}) {
  if (args.includes('-h') || args.includes('--help')) {
    out(t('helpText', {}))
    return 0
  }
  const { opts, error } = parseRepairArgs(args)
  if (error) {
    log(t(error.key, error.params))
    return 2
  }

  // 台账定位：省略 --profile 时跨 profile 搜索；省略 id 时——
  //   恰好一条隔离记录 → 直接修它（最常见情况）；
  //   多条 → 列出清单让用户挑（标记哪些可自动修复）。
  const ledger = loadLedger()
  let matches = []
  for (const [profile, entries] of Object.entries(ledger.profiles)) {
    if (opts.profile && profile !== opts.profile) continue
    for (const entry of entries ?? []) {
      if (opts.id === undefined || entry.id === opts.id) matches.push({ profile, entry })
    }
  }
  if (opts.id === undefined) {
    if (!matches.length) {
      log(t('noRecords'))
      return 0
    }
    if (matches.length > 1) {
      log(t('repairPickOne', { count: matches.length }))
      for (const m of matches) {
        const repairable = REPAIRABLE_RE.test(m.entry.reason ?? '')
        log(`  - ${m.entry.id}（${m.entry.name ?? '-'}）${repairable ? '' : t('repairNotSupportedTag')}`)
      }
      return 0
    }
    opts.id = matches[0].entry.id
  }
  if (!matches.length) {
    log(t('repairEntryMissing', { id: opts.id }))
    return 1
  }
  if (matches.length > 1) {
    log(t('repairAmbiguous', { id: opts.id, profiles: matches.map((m) => m.profile).join(', ') }))
    return 2
  }
  const { profile, entry } = matches[0]
  const name = entry.name ?? entry.id

  // 类别门禁：重复挂载是配置层问题（同一 id 多处挂载），重装无意义——
  // 但可以自动去重：从 profile 的 bundles 移除一个挂载来源
  if (/duplicate loader entry id/i.test(entry.reason ?? '')) {
    return dedupeForDuplicate({ id: opts.id, profile, opts, spawn, log, write })
  }
  // 只修"包的安装状态/版本适配"类
  if (!REPAIRABLE_RE.test(entry.reason ?? '')) {
    log(t('repairUnsupported', { reason: summarizeLine(entry.reason) }))
    return 1
  }

  const target = opts.to ?? 'latest'
  const spec = `${name}@${target}`
  const spawnTarget = resolveDshSpawnTarget('dsh')
  const commandDesc = `dsh plugin --profile ${profile} add ${spec}`
  log(t('repairPlan', { profile, name, command: commandDesc }))
  if (opts.dryRun) {
    log(t('dryRunNotice'))
    return 0
  }
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      log(t('updateNonInteractive'))
      return 1
    }
    const ok = await askConfirm(t('updateConfirm'))
    if (!ok) {
      log(t('updateAborted'))
      return 0
    }
  }

  const { status } = spawn(spawnTarget.file, [...spawnTarget.prefix, 'plugin', '--profile', profile, 'add', spec], {
    stdio: 'inherit',
    shell: spawnTarget.shell,
    env: process.env,
  })
  if (status !== 0) {
    log(t('repairInstallFailed', { code: status ?? '?' }))
    return status ?? 1
  }

  const { restored } = restoreQuarantine(profile, [opts.id], false)
  if (!restored.length) {
    log(t('noMatching'))
  } else {
    const e = restored[0]
    write(`[dsh-safe] ${t('restored')} ${e.name ?? e.id} (id: ${e.id})`)
  }

  // 防复发：修复的插件若同时被多个 bundle 挂载（如聚合包已内置同一插件），
  // 恢复后下次启动会 duplicate——自动去重（交互选择保留来源，-y 保留先声明者）
  const knownAfter = collectKnownRows(profile)
  const sources = bundleMountSources(knownAfter, opts.id)
  if (sources.length >= 2) {
    const manifest = readJsonIfExists(profileManifestPath(profile))
    const declared = manifest?.dsh?.profile?.bundles
    const ordered = Array.isArray(declared)
      ? [...sources].sort(
          (a, b) =>
            (declared.indexOf(a) < 0 ? 999 : declared.indexOf(a)) - (declared.indexOf(b) < 0 ? 999 : declared.indexOf(b)),
        )
      : sources
    let keep = ordered[0]
    if (!opts.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      log(t('repairDedupePick', { id: opts.id }))
      ordered.forEach((b, i) => log(`${i + 1}. ${b}${i === 0 ? t('repairDedupeDefault') : ''}`))
      const answer = await rl.question(t('repairDedupeChoose'))
      rl.close()
      const pick = Math.min(Math.max(parseInt(answer, 10) || 1, 1), ordered.length)
      keep = ordered[pick - 1]
    }
    const removed = ordered.filter((b) => b !== keep)
    if (removeFromManifestBundles(profile, removed)) {
      log(t('repairDedupeDone', { removed: removed.join(', '), keep }))
    }
  }

  log(t('repairDone'))
  return 0
}

function askConfirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  return rl.question(question).then(
    (answer) => {
      rl.close()
      const a = answer.trim().toLowerCase()
      return a === 'y' || a === 'yes'
    },
    () => {
      rl.close()
      return false
    },
  )
}

const readJsonIfExists = (path) => {
  const raw = readIfExists(path)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** 该 id 的 bundle 挂载来源（profile/home 层是 override，不算挂载来源）。 */
function bundleMountSources(known, id) {
  return [
    ...new Set(
      known.rows.filter((r) => r.id === id && r.source !== 'profile' && r.source !== 'home').map((r) => r.source),
    ),
  ]
}

/** 从 profile 清单的 bundles 数组移除指定来源；没有变化返回 false。 */
function removeFromManifestBundles(profile, removeNames) {
  const manifestPath = profileManifestPath(profile)
  const manifest = readJsonIfExists(manifestPath)
  const current = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(current)) return false
  const next = current.filter((b) => !removeNames.includes(b))
  if (next.length === current.length) return false
  manifest.dsh.profile.bundles = next
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return true
}

/**
 * duplicate 类的自动去重：同一 id 被多个 bundle 挂载时，从 profile 清单的
 * bundles 数组移除一个来源（保留的来源继续提供插件），并摘除无效的禁用行。
 * 编辑的是用户自己的 profile 清单（与 cordis.patch.yml 托管区块同信任级别），
 * 有确认环节、可逆（bundles 加回来即可）。
 */
async function dedupeForDuplicate({ id, profile, opts, spawn, log, write }) {
  const known = collectKnownRows(profile)
  // 挂载来源只统计 bundle 层；profile/home 层的同 id 是 override，不是重复来源
  const sources = new Set()
  for (const row of known.rows) {
    if (row.id !== id) continue
    if (row.source === 'profile' || row.source === 'home') continue
    sources.add(row.source)
  }
  const sourceList = [...sources]
  if (sourceList.length < 2) {
    // 重复不在 bundle 层（可能在 include 文件或用户层），自动去重帮不上，给指引
    log(t('repairDuplicate'))
    return 1
  }

  const manifestPath = profileManifestPath(profile)
  const manifest = readJsonIfExists(manifestPath)
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) {
    log(t('repairDedupeNoManifest'))
    return 1
  }
  // 按 bundles 数组声明顺序排序：先声明的是既有来源，缺省保留
  const ordered = [...sourceList].sort((a, b) => {
    const ia = bundles.indexOf(a)
    const ib = bundles.indexOf(b)
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
  })

  const keepDefault = ordered[0]
  const planLine = () => log(t('repairDedupePlan', { keep: keep, remove: remove.join(', '), id }))
  if (opts.dryRun) {
    log(t('repairDedupePlan', { keep: keepDefault, remove: ordered.slice(1).join(', '), id }))
    log(t('dryRunNotice'))
    return 0
  }

  let keep
  if (!opts.yes && !process.stdin.isTTY) {
    log(t('updateNonInteractive'))
    return 1
  }
  if (opts.yes) {
    keep = keepDefault // -y：保留先声明的来源
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    log(t('repairDedupePick', { id }))
    ordered.forEach((b, i) => log(`${i + 1}. ${b}${i === 0 ? t('repairDedupeDefault') : ''}`))
    const answer = await rl.question(t('repairDedupeChoose'))
    rl.close()
    const pick = Math.min(Math.max(parseInt(answer, 10) || 1, 1), ordered.length)
    keep = ordered[pick - 1]
  }
  const remove = ordered.filter((b) => b !== keep)
  planLine()

  const fresh = readJsonIfExists(manifestPath)
  const current = fresh?.dsh?.profile?.bundles
  if (!Array.isArray(current)) {
    log(t('repairDedupeNoManifest'))
    return 1
  }
  const next = current.filter((b) => !remove.includes(b))
  if (next.length === current.length) {
    log(t('repairDedupeNoManifest'))
    return 1
  }
  fresh.dsh.profile.bundles = next
  writeFileSync(manifestPath, `${JSON.stringify(fresh, null, 2)}\n`)

  const { restored } = restoreQuarantine(profile, [id], false)
  if (restored.length) {
    const e = restored[0]
    write(`[dsh-safe] ${t('restored')} ${e.name ?? e.id} (id: ${e.id})`)
  }
  log(t('repairDedupeDone', { removed: remove.join(', '), keep }))
  log(t('repairDone'))
  return 0
}
