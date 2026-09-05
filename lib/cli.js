/**
 * @hyzyn/dsh-safe — 命令行入口。
 *
 * 用法：
 *   dsh-safe <dsh 参数…>        包装运行 dsh（dsh-safe 的旗标必须写在最前）
 *   dsh-safe list [--profile <名>]
 *   dsh-safe restore --profile <名> (--id <id>… | --all) [--dry-run]
 *   dsh-safe help | --version
 */
import { createRequire } from 'node:module'
import { loadLedger, restoreQuarantine } from './quarantine.js'
import { runWrapped } from './wrap.js'
import { cmdUpdate, cmdUpdateAndBoot } from './update.js'
import { t } from './i18n.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')

function printHelp() {
  process.stdout.write(t('helpText', { version }))
}

function printVersion() {
  process.stdout.write(`${version}\n`)
}

/** 解析 `--profile <名>` / `--profile=<名>`，返回 [值, 剩余参数]。 */
function takeProfile(args) {
  let profile
  const rest = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--profile') {
      profile = args[++i]
    } else if (args[i].startsWith('--profile=')) {
      profile = args[i].slice('--profile='.length)
    } else {
      rest.push(args[i])
    }
  }
  return [profile, rest]
}

/** 解析可重复的 `--id <id>` / `--id=<id>`。 */
function takeIds(args) {
  const ids = []
  const rest = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--id') {
      const v = args[++i]
      if (v !== undefined) ids.push(v)
    } else if (args[i].startsWith('--id=')) {
      ids.push(args[i].slice('--id='.length))
    } else {
      rest.push(args[i])
    }
  }
  return [ids, rest]
}

function cmdList(args) {
  const [profile] = takeProfile(args)
  const ledger = loadLedger()
  const profiles = profile ? [profile] : Object.keys(ledger.profiles).sort()
  let found = 0
  for (const p of profiles) {
    const entries = ledger.profiles[p] ?? []
    if (!entries.length) continue
    process.stdout.write(`${p}:\n`)
    for (const e of entries) {
      found++
      process.stdout.write(
        `  - ${e.name ?? t('unknownName')} (id: ${e.id})\n${t('quarantinedAt', { time: e.quarantinedAt })}\n${t('reasonLine', { reason: e.reason })}\n${t('locationLine', { file: e.file })}\n`,
      )
    }
  }
  if (!found) process.stdout.write(profile ? `${t('noRecordsProfile', { profile })}\n` : `${t('noRecords')}\n`)
  return 0
}

function cmdRestore(args) {
  const [profile0, rest0] = takeProfile(args)
  const [ids0, rest1] = takeIds(rest0)
  const dryRun = rest1.includes('--dry-run')
  const all = rest1.includes('--all')
  const profile = profile0
  if (!profile) {
    process.stderr.write(`${t('restoreNeedsProfile')}\n`)
    return 2
  }
  if (!all && ids0.length === 0) {
    process.stderr.write(`${t('restoreNeedsId')}\n`)
    return 2
  }
  const { restored, kept } = restoreQuarantine(profile, all ? 'all' : ids0, dryRun)
  const verb = t(dryRun ? 'restoredDry' : 'restored')
  for (const e of restored) process.stdout.write(`[dsh-safe] ${verb} ${e.name ?? e.id} (id: ${e.id})\n`)
  if (!restored.length) process.stdout.write(`${t('noMatching')}\n`)
  else if (kept.length) process.stdout.write(`${t('stillQuarantined', { profile, count: kept.length })}\n`)
  else process.stdout.write(`${t('ledgerCleared')}\n`)
  return 0
}

/**
 * @param {string[]} argv process.argv.slice(2)
 * @returns {Promise<number>} 退出码
 */
export async function main(argv) {
  if (argv.length === 0) {
    printHelp()
    return 0
  }
  const [cmd] = argv
  if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
    printHelp()
    return 0
  }
  if (cmd === '--version' || cmd === '-V' || cmd === 'version') {
    printVersion()
    return 0
  }
  if (cmd === 'list') return cmdList(argv.slice(1))
  if (cmd === 'restore') return cmdRestore(argv.slice(1))
  if (cmd === 'update') return cmdUpdate(argv.slice(1))
  if (cmd === '-u' || cmd === '--update') return cmdUpdateAndBoot(argv.slice(1), { boot: runWrapperMode })

  // 包装模式：剥掉 dsh-safe 自己的旗标（必须出现在第一个位置参数之前），
  // 其余原样转发给 dsh。
  return runWrapperMode(argv)
}

/** 包装模式：剥离 dsh-safe 的旗标后运行 dsh；-u 升级完成后的启动也走这里。 */
async function runWrapperMode(argv) {
  const forwardArgs = []
  let dryRun = false
  let maxRetries = 2
  let allowFirstParty = false
  let i = 0
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') { dryRun = true; continue }
    if (a === '--allow-first-party') { allowFirstParty = true; continue }
    if (a === '--max-retries') {
      const raw = argv[++i]
      const v = raw === undefined || raw === '' ? NaN : Number(raw)
      if (!Number.isFinite(v) || v < 0) {
        process.stderr.write(`${t('maxRetriesInvalid')}\n`)
        return 2
      }
      maxRetries = v
      continue
    }
    if (a.startsWith('--max-retries=')) {
      const raw = a.slice('--max-retries='.length)
      const v = raw === '' ? NaN : Number(raw)
      if (!Number.isFinite(v) || v < 0) {
        process.stderr.write(`${t('maxRetriesInvalid')}\n`)
        return 2
      }
      maxRetries = v
      continue
    }
    break
  }
  forwardArgs.push(...argv.slice(i))
  if (!forwardArgs.length) {
    printHelp()
    return 0
  }
  if (dryRun) process.stderr.write(`${t('dryRunNotice')}\n`)
  return runWrapped({ forwardArgs, dryRun, maxRetries, allowFirstParty })
}
