/**
 * @hyzyn/dsh-safe — `dsh-safe repair` 与 `dsh-safe -r`：修复被隔离的插件。
 *
 * repair 可修复的失败特征：问题出在"包的安装状态或版本适配"上，重装/升级
 * 插件包可能修复——
 *   - 模块解析失败：包缺失/损坏/未安装 → 重装即愈；
 *   - ESM 导出不匹配（does not provide an [export|import binding]）：插件与
 *     当前 dsh API 版本不兼容，升级插件到适配版本可能修复（真实案例：
 *     describe-image 隔离于 dsh-settings 导出变更）。修复失败不恢复、无损。
 * 注意：台账 reason 经 summarizeLine 截断过（160 字符），关键短语可能被
 * "…" 切断，因此导出不匹配的特征只匹配到 "does not provide an" 为止。
 *
 * duplicate（同一 id 被多个 bundle 挂载）是配置层问题，重装无意义——但
 * 支持自动去重：从 profile 清单的 bundles 移除一个来源（交互选择保留哪个，
 * -y 保留先声明者），并摘除无效的禁用行。include 子文件里的重复不在
 * bundle 层对照表内，自动去重帮不上，给手动指引。
 *
 * 安装路径修复完成后会复查该 id 的挂载来源：修复的插件若同时被聚合包等
 * 其它 bundle 挂载，恢复后下次启动会 duplicate——自动去重防复发。
 *
 * `--all` 批量修复台账里全部可修复记录；`-r/--repair` = 批量修复 + 启动
 * （与 -u 对称：位置参数全部是 dsh 启动参数）。
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

const REPAIRABLE_RE =
  /Cannot find package|could not be resolved|ERR_MODULE_NOT_FOUND|does not provide an( (?:export|import binding))?/i
const DUPLICATE_RE = /duplicate loader entry id/i

const isRepairable = (reason) => REPAIRABLE_RE.test(reason ?? '') || DUPLICATE_RE.test(reason ?? '')

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

/**
 * 对单条隔离记录执行修复动作。安装确认由调用方完成（单条路径确认、批量
 * 路径整体确认后以 yes: true 调用）。
 * @returns {Promise<{ code: number, outcome: 'repaired'|'deduped'|'skipped'|'failed' }>}
 */
async function repairEntry({ profile, entry, to = undefined, yes = false, tty = true, dryRun = false, spawn = spawnSync, log = err, write = out }) {
  const id = entry.id

  // duplicate：自动去重（多 bundle 来源），来源不足给手动指引
  if (DUPLICATE_RE.test(entry.reason ?? '')) {
    const sources = bundleMountSources(collectKnownRows(profile), id)
    if (sources.length < 2) {
      log(t('repairDuplicate'))
      return { code: 1, outcome: 'skipped' }
    }
    const manifest = readJsonIfExists(profileManifestPath(profile))
    const declared = manifest?.dsh?.profile?.bundles
    const ordered = Array.isArray(declared)
      ? [...sources].sort(
          (a, b) =>
            (declared.indexOf(a) < 0 ? 999 : declared.indexOf(a)) - (declared.indexOf(b) < 0 ? 999 : declared.indexOf(b)),
        )
      : sources
    let keep = ordered[0]
    if (!yes && !dryRun) {
      if (!tty) {
        log(t('updateNonInteractive'))
        return { code: 1, outcome: 'failed' }
      }
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      log(t('repairDedupePick', { id }))
      ordered.forEach((b, i) => log(`${i + 1}. ${b}${i === 0 ? t('repairDedupeDefault') : ''}`))
      const answer = await rl.question(t('repairDedupeChoose'))
      rl.close()
      const pick = Math.min(Math.max(parseInt(answer, 10) || 1, 1), ordered.length)
      keep = ordered[pick - 1]
    }
    const remove = ordered.filter((b) => b !== keep)
    log(t('repairDedupePlan', { keep, remove: remove.join(', '), id }))
    if (dryRun) {
      log(t('dryRunNotice'))
      return { code: 0, outcome: 'deduped' }
    }
    if (!removeFromManifestBundles(profile, remove)) {
      log(t('repairDedupeNoManifest'))
      return { code: 1, outcome: 'failed' }
    }
    const { restored } = restoreQuarantine(profile, [id], false)
    if (restored.length) {
      const e = restored[0]
      write(`[dsh-safe] ${t('restored')} ${e.name ?? e.id} (id: ${e.id})`)
    }
    log(t('repairDedupeDone', { removed: remove.join(', '), keep }))
    log(t('repairDone'))
    return { code: 0, outcome: 'deduped' }
  }

  // 其它非包类失败：拒接并给针对性指引
  if (!REPAIRABLE_RE.test(entry.reason ?? '')) {
    log(t('repairUnsupported', { reason: summarizeLine(entry.reason) }))
    return { code: 1, outcome: 'skipped' }
  }

  // 安装 + 恢复
  const spec = `${entry.name ?? entry.id}@${to ?? 'latest'}`
  const spawnTarget = resolveDshSpawnTarget('dsh')
  const commandDesc = `dsh plugin --profile ${profile} add ${spec}`
  log(t('repairPlan', { profile, name: entry.name ?? entry.id, command: commandDesc }))
  if (dryRun) {
    log(t('dryRunNotice'))
    return { code: 0, outcome: 'repaired' }
  }

  const { status } = spawn(spawnTarget.file, [...spawnTarget.prefix, 'plugin', '--profile', profile, 'add', spec], {
    stdio: 'inherit',
    shell: spawnTarget.shell,
    env: process.env,
  })
  if (status !== 0) {
    log(t('repairInstallFailed', { code: status ?? '?' }))
    return { code: status ?? 1, outcome: 'failed' }
  }

  const { restored } = restoreQuarantine(profile, [id], false)
  if (!restored.length) {
    log(t('noMatching'))
  } else {
    const e = restored[0]
    write(`[dsh-safe] ${t('restored')} ${e.name ?? e.id} (id: ${e.id})`)
  }

  // 防复发：修复的插件若同时被多个 bundle 挂载（如聚合包已内置同一插件），
  // 恢复后下次启动会 duplicate——自动去重（交互选择保留来源，-y 保留先声明者）
  const knownAfter = collectKnownRows(profile)
  const sources = bundleMountSources(knownAfter, id)
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
    if (!yes) {
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      log(t('repairDedupePick', { id }))
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
  return { code: 0, outcome: 'repaired' }
}

function parseRepairArgs(args) {
  const opts = { id: undefined, all: false, profile: undefined, to: undefined, yes: false, dryRun: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-y' || a === '--yes') opts.yes = true
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--all') opts.all = true
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
    else return { error: { key: 'repairUnknownArg', params: { arg: a } } }
  }
  if (opts.all && opts.id !== undefined) return { error: { key: 'repairAllConflict' } }
  if (opts.to !== undefined && !/^[\w.+-]+$/.test(opts.to)) return { error: { key: 'updateToInvalid' } }
  return { opts }
}

/** 台账定位：按 id / --all / 菜单三种形态收集修复目标。 */
function collectTargets(opts, ledger) {
  const matches = []
  for (const [profile, entries] of Object.entries(ledger.profiles)) {
    if (opts.profile && profile !== opts.profile) continue
    for (const entry of entries ?? []) {
      if (opts.all || opts.id === undefined || entry.id === opts.id) matches.push({ profile, entry })
    }
  }
  return matches
}

/** 批量修复：一次确认，逐条执行，汇总结果。返回失败的条数。 */
async function repairBatch(targets, { to = undefined, yes = false, dryRun = false, spawn = spawnSync, log = err, write = out }) {
  const repairable = targets.filter((t) => isRepairable(t.entry.reason))
  const unsupported = targets.filter((t) => !repairable.includes(t))
  log(
    t('repairBatchPlan', {
      count: repairable.length,
      ids: repairable.map((t) => t.entry.id).join(', ') || '-',
    }),
  )
  if (unsupported.length) {
    log(t('repairBatchSkip', { count: unsupported.length, ids: unsupported.map((t) => t.entry.id).join(', ') }))
  }
  if (dryRun) {
    for (const t of repairable) {
      await repairEntry({ profile: t.profile, entry: t.entry, to: to, yes: true, tty: true, dryRun: true, spawn, log, write })
    }
    log(t('dryRunNotice'))
    return { failed: 0 }
  }
  if (!yes) {
    if (!process.stdin.isTTY) {
      log(t('updateNonInteractive'))
      return { failed: targets.length }
    }
    const ok = await askConfirm(t('updateConfirm'))
    if (!ok) {
      log(t('updateAborted'))
      return { failed: 0 }
    }
  }
  let repaired = 0
  let failed = 0
  for (const t of repairable) {
    const { code } = await repairEntry({ profile: t.profile, entry: t.entry, to: to, yes: true, tty: true, spawn, log, write })
    if (code === 0) repaired++
    else failed++
  }
  log(t('repairBatchDone', { repaired, failed }))
  return { failed }
}

/**
 * @param {string[]} args
 * @param {{
 *   spawn?: typeof spawnSync,
 *   log?: (line: string) => void,
 *   write?: (line: string) => void,
 * }} [hooks]
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

  const ledger = loadLedger()
  const matches = collectTargets(opts, ledger)

  // --all：批量修复（一次确认，默认策略）
  if (opts.all) {
    if (!matches.length) {
      log(t('noRecords'))
      return 0
    }
    const { failed } = await repairBatch(matches, { to: opts.to, yes: opts.yes, dryRun: opts.dryRun, spawn, log, write })
    return failed ? 1 : 0
  }

  // 无 id：单条直接修；多条列菜单让用户挑
  if (opts.id === undefined) {
    if (!matches.length) {
      log(t('noRecords'))
      return 0
    }
    if (matches.length > 1) {
      log(t('repairPickOne', { count: matches.length }))
      for (const m of matches) {
        const repairable = isRepairable(m.entry.reason)
        log(`  - ${m.entry.id}（${m.entry.name ?? '-'}）${repairable ? '' : t('repairNotSupportedTag')}`)
      }
      return 0
    }
    opts.id = matches[0].entry.id
  }

  if (!matches.length) {
    // duplicate 类失败不会产生台账条目（0.12.1 起的设计）——台账查无记录时，
    // 按挂载来源直接支持去重：该 id 被 ≥2 个 bundle 挂载即视为重复挂载目标。
    const candidates = opts.profile
      ? [opts.profile]
      : (() => {
          try {
            return readdirSync(join(dshHome(), 'profiles'), { withFileTypes: true })
              .filter((e) => e.isDirectory())
              .map((e) => e.name)
          } catch {
            return []
          }
        })()
    for (const p of candidates) {
      if (bundleMountSources(collectKnownRows(p), opts.id).length >= 2) {
        const rows = collectKnownRows(p).rows.filter((r) => r.id === opts.id)
        matches.push({
          profile: p,
          entry: { id: opts.id, name: rows[0]?.name ?? null, reason: 'duplicate loader entry id' },
        })
        break
      }
    }
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

  // 单条路径：安装前确认（dry-run 免确认）
  if (!opts.dryRun && !opts.yes) {
    if (!process.stdin.isTTY) {
      log(t('updateNonInteractive'))
      return 1
    }
    if (!(await askConfirm(t('updateConfirm')))) {
      log(t('updateAborted'))
      return 0
    }
  }
  const { code } = await repairEntry({ profile, entry, to: opts.to, yes: opts.yes || !opts.dryRun ? true : false, tty: true, dryRun: opts.dryRun, spawn, log, write })
  return code
}

/**
 * `-r/--repair [dsh 参数…]`：批量修复全部可修复的隔离记录，再按包装模式
 * 启动（与 -u 对称：位置参数全部是 dsh 启动参数）。
 * @param {string[]} args
 * @param {{
 *   spawn?: typeof spawnSync,
 *   boot?: (args: string[]) => Promise<number>,
 *   log?: (line: string) => void,
 *   write?: (line: string) => void,
 *   isTTY?: boolean,
 *   readStdin?: never,
 * }} [hooks]
 * @returns {Promise<number>} 退出码
 */
export async function cmdRepairAndBoot(args, { boot, spawn = spawnSync, log = err, write = out, isTTY = process.stdin.isTTY } = {}) {
  if (args.includes('-h') || args.includes('--help')) {
    out(t('helpText', {}))
    return 0
  }
  // 位置参数全部是 dsh 启动参数（修全部可修复记录）；前缀旗标为 repair 选项
  const opts = { profile: undefined, to: undefined, yes: false, dryRun: false }
  let i = 0
  for (; i < args.length; i++) {
    const a = args[i]
    if (a === '-y' || a === '--yes') opts.yes = true
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--profile' && args[i + 1] !== undefined) opts.profile = args[++i]
    else if (a.startsWith('--profile=')) opts.profile = a.slice('--profile='.length)
    else if (a === '--to' && args[i + 1] !== undefined) opts.to = args[++i]
    else if (a.startsWith('--to=')) opts.to = a.slice('--to='.length)
    else break
  }
  if (opts.to !== undefined && !/^[\w.+-]+$/.test(opts.to)) {
    log(t('updateToInvalid'))
    return 2
  }
  const bootArgs = args.slice(i)

  const ledger = loadLedger()
  const targets = []
  for (const [profile, entries] of Object.entries(ledger.profiles)) {
    if (opts.profile && profile !== opts.profile) continue
    for (const entry of entries ?? []) targets.push({ profile, entry })
  }

  // --profile 同时作用于修复与启动：启动参数未显式给 --profile 时自动补上
  const finalBootArgs =
    opts.profile && !bootArgs.some((a) => a === '--profile' || a.startsWith('--profile='))
      ? ['--profile', opts.profile, ...bootArgs]
      : bootArgs

  if (!targets.length) {
    log(t('noRecords'))
    if (bootArgs.length) return boot(finalBootArgs)
    return 0
  }

  const { failed } = await repairBatch(targets, { to: opts.to, yes: opts.yes, dryRun: opts.dryRun, spawn, log, write })

  if (bootArgs.length) return boot(finalBootArgs)
  return failed ? 1 : 0
}
