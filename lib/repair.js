/**
 * @hyzyn/dsh-safe — `dsh-safe repair`：修复被隔离的插件。
 *
 * repair 可修复的失败特征：问题出在"包的安装状态或版本适配"上，重装/升级
 * 插件包可能修复——
 *   - 模块解析失败：包缺失/损坏/未安装 → 重装即愈；
 *   - ESM 导出不匹配（does not provide an [export|import binding]）：插件与
 *     当前 dsh API 版本不兼容，升级插件到适配版本可能修复（真实案例：
 *     describe-image 隔离于 dsh-settings 导出变更）。修复失败不恢复、无损。
 * 注意：台账 reason 经 summarizeLine 截断过（160 字符），关键短语可能被
 * "…" 切断，因此导出不匹配的特征只匹配到 "does not provide an" 为止；
 * 但 id/包名特别长时（如 dsh-client-ui-web-ui-settings）连这个短语都会被
 * 切掉，只剩 "does not p…"——所以再补 "The requested module"（ESM 具名
 * 导出报错的固定开头，位置靠前不会被截掉）。
 *
 * duplicate（同一 id 被多个 bundle 挂载）是配置层问题，重装无意义——但
 * 支持自动去重（见 dedupe.js）：从 profile 清单的 bundles 移除一个来源
 * （交互选择保留哪个；非交互缺省保留官方 bundle，否则保留先声明者；移除
 * 官方 bundle 受第一方守卫约束），并摘除无效的禁用行。include
 * 子文件里的重复不在 bundle 层对照表内，自动去重帮不上，给手动指引。
 *
 * 安装路径修复完成后会复查该 id 的挂载来源：修复的插件若同时被聚合包等
 * 其它 bundle 挂载，恢复后下次启动会 duplicate——自动去重防复发。
 * 注意 dsh 会在每次 plugin add 时把 dependencies 里的 bundle 型包重新
 * reconcile 进 bundles，去重成果可能被复活——包装启动的自愈（wrap.js）
 * 与本命令的预检都会再次兜住。
 *
 * `--all` 批量修复台账里全部可修复记录（含未入账 duplicate 预检）。
 * （0.15.0 起 `-r/--repair` 组合命令已移除：保活全部由包装启动承担——隔离
 * 重试与 duplicate 自愈见 wrap.js；修复交给 repair 原语，由用户手动调用
 * 或 web UI 里的 AI agent 执行。）
 */
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { loadLedger, restoreQuarantine } from './quarantine.js'
import { summarizeLine } from './failures.js'
import { profileDirs, resolveDshSpawnTarget } from './dshpaths.js'
import { collectKnownRows } from './knownrows.js'
import { dedupeMountSources } from './dedupe.js'
import { t } from './i18n.js'

const err = (line) => process.stderr.write(`${line}\n`)
const out = (line) => process.stdout.write(`${line}\n`)

const REPAIRABLE_RE =
  /Cannot find package|could not be resolved|ERR_MODULE_NOT_FOUND|The requested module|does not provide an( (?:export|import binding))?/i
const DUPLICATE_RE = /duplicate loader entry id/i

const isRepairable = (reason) => REPAIRABLE_RE.test(reason ?? '') || DUPLICATE_RE.test(reason ?? '')

/**
 * 预检未入账的 duplicate：duplicate 失败不产生台账条目（0.12.1 起的设计），
 * 只能按挂载来源发现——某 profile 下该 id 被 ≥2 个 bundle 挂载即视为目标。
 * @param {Array<{ profile: string, entry: { id: string } }>} targets 已收集的修复目标（其中的 id 视为已入账，不重复预检）
 * @param {string=} profileFilter 指定 profile 时只扫它
 * @param {{ allProfiles?: boolean }} [opts] 无 profileFilter 时是否补扫全部 profile 目录（repair --all 用）
 * @returns {Array<{ profile: string, entry: { id: string, name: string|null, reason: string } }>}
 */
function findUnledgeredDuplicates(targets, profileFilter, { allProfiles = false } = {}) {
  const ledgerIds = new Map()
  for (const t of targets) {
    if (!ledgerIds.has(t.profile)) ledgerIds.set(t.profile, new Set())
    ledgerIds.get(t.profile).add(t.entry.id)
  }
  const scanProfiles = profileFilter
    ? [profileFilter]
    : [...new Set([...targets.map((t) => t.profile), ...(allProfiles ? profileDirs() : [])])]
  const found = []
  for (const p of scanProfiles) {
    const known = collectKnownRows(p)
    const byId = new Map()
    for (const row of known.rows) {
      if (row.source === 'profile' || row.source === 'home') continue
      if (!byId.has(row.id)) byId.set(row.id, new Set())
      byId.get(row.id).add(row.source)
    }
    const ledgered = ledgerIds.get(p) ?? new Set()
    for (const [dupId, srcs] of byId) {
      if (srcs.size < 2 || ledgered.has(dupId)) continue
      const nameRow = known.rows.find((r) => r.id === dupId)
      found.push({ profile: p, entry: { id: dupId, name: nameRow?.name ?? null, reason: 'duplicate loader entry id' } })
    }
  }
  return found
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

  // duplicate：自动去重（多 bundle 来源），来源不足给手动指引；
  // 保留方案涉及官方 bundle 时被 dedupe 的第一方守卫拒绝（原因由其打印）
  if (DUPLICATE_RE.test(entry.reason ?? '')) {
    const res = await dedupeMountSources(profile, id, { yes, tty, dryRun, log })
    if ('error' in res) {
      if (res.error === 'no-manifest') log(t('repairDedupeNoManifest'))
      else if (res.error !== 'first-party') log(t('repairDuplicateManual'))
      return { code: 1, outcome: res.error === 'no-manifest' ? 'failed' : 'skipped' }
    }
    if (dryRun) {
      log(t('dryRunNotice'))
      return { code: 0, outcome: 'deduped' }
    }
    const { restored } = restoreQuarantine(profile, [id], false)
    if (restored.length) {
      const e = restored[0]
      write(`[dsh-safe] ${t('restored')} ${e.name ?? e.id} (id: ${e.id})`)
    }
    log(t('repairDedupeDone', { keep: res.kept, removed: res.removed.join(', ') }))
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
  // 恢复后下次启动会 duplicate——自动去重（缺省保留官方来源，否则先声明来源）
  const res = await dedupeMountSources(profile, id, { yes, tty, log })
  if (!('error' in res)) {
    log(t('repairDedupeDone', { keep: res.kept, removed: res.removed.join(', ') }))
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

/** 批量修复：一次确认，逐条执行，汇总结果。返回 { failed, repaired, done }，
 * done 只收安装修复成功的条目（去重成功不算——去重后暴露出的新失败仍值得再修）。 */
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
    return { failed: 0, repaired: 0, done: [] }
  }
  if (!yes) {
    if (!process.stdin.isTTY) {
      log(t('updateNonInteractive'))
      return { failed: targets.length, repaired: 0, done: [] }
    }
    const ok = await askConfirm(t('updateConfirm'))
    if (!ok) {
      log(t('updateAborted'))
      return { failed: 0, repaired: 0, done: [] }
    }
  }
  let repaired = 0
  let failed = 0
  const done = []
  for (const t of repairable) {
    const { code, outcome } = await repairEntry({ profile: t.profile, entry: t.entry, to: to, yes: true, tty: true, spawn, log, write })
    if (code === 0) {
      repaired++
      if (outcome === 'repaired') done.push({ profile: t.profile, id: t.entry.id })
    } else {
      failed++
    }
  }
  log(t('repairBatchDone', { repaired, failed }))
  return { failed, repaired, done }
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

  // --all：批量修复（一次确认，默认策略）；先预检未入账的 duplicate
  // （与包装启动的自愈对齐：duplicate 不产生台账条目，台账为空也可能有修复目标）
  if (opts.all) {
    matches.push(...findUnledgeredDuplicates(matches, opts.profile, { allProfiles: true }))
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
    // 不指定 --profile 时扫全部 profile 目录（与修复目标跨 profile 的语义一致）。
    const dup = findUnledgeredDuplicates([], opts.profile, { allProfiles: true }).find((m) => m.entry.id === opts.id)
    if (dup) matches.push(dup)
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
