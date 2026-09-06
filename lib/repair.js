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
import { loadLedger, restoreQuarantine } from './quarantine.js'
import { summarizeLine } from './failures.js'
import { resolveDshSpawnTarget } from './dshpaths.js'
import { t } from './i18n.js'

const err = (line) => process.stderr.write(`${line}\n`)
const out = (line) => process.stdout.write(`${line}\n`)

/** 台账 reason 里判定"模块解析失败"的特征。 */
const RESOLVE_FAIL_RE = /Cannot find package|could not be resolved|ERR_MODULE_NOT_FOUND/i

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
  if (opts.id === undefined) return { error: { key: 'repairIdRequired' } }
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

  // 台账定位：省略 --profile 时跨 profile 搜索
  const ledger = loadLedger()
  const matches = []
  for (const [profile, entries] of Object.entries(ledger.profiles)) {
    if (opts.profile && profile !== opts.profile) continue
    for (const entry of entries ?? []) {
      if (entry.id === opts.id) matches.push({ profile, entry })
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
  const name = entry.name ?? entry.id

  // 类别门禁：只修"模块解析失败"类
  if (!RESOLVE_FAIL_RE.test(entry.reason ?? '')) {
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
