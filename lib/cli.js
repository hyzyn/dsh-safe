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
import { writeFileSync } from 'node:fs'
import { loadLedger, restoreQuarantine } from './quarantine.js'
import { runWrapped } from './wrap.js'
import { cmdUpdate, cmdUpdateAndBoot, maybeNotifySelfUpdate } from './update.js'
import { cmdRepair } from './repair.js'
import { printDoctor } from './doctor.js'
import { cmdExplain } from './ai.js'
import { profileDirs, profilePatchPath, readIfExists } from './dshpaths.js'
import { applyManagedBlock, managedBlockText, scanPatchRows } from './patchfile.js'
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

/**
 * 孤儿禁用行：托管区块里有、台账里没有的行。克隆 profile 会把 patch（含
 * 托管区块）复制过来，而台账按 profile 记录、不会跟着克隆——这些行既不可
 * 见也不可恢复，只能靠这里暴露。
 */
function orphanRows(profile, ledger) {
  const block = managedBlockText(readIfExists(profilePatchPath(profile)) ?? '')
  if (block === null) return []
  const ledgerIds = new Set((ledger.profiles[profile] ?? []).map((e) => e.id))
  return scanPatchRows(block).filter((r) => !ledgerIds.has(r.id))
}

function cmdList(args) {
  const [profile, rest] = takeProfile(args)
  const ledger = loadLedger()
  const scanProfiles = profile ? [profile] : [...new Set([...Object.keys(ledger.profiles), ...profileDirs()])]
  const orphansByProfile = {}
  for (const p of scanProfiles) {
    const orphans = orphanRows(p, ledger)
    if (orphans.length) orphansByProfile[p] = orphans.map((r) => ({ id: r.id, name: r.name }))
  }
  if (rest.includes('--json')) {
    const profiles = profile ? { [profile]: ledger.profiles[profile] ?? [] } : ledger.profiles
    process.stdout.write(`${JSON.stringify({ version: ledger.version ?? 1, profiles, orphans: orphansByProfile }, null, 2)}\n`)
    return 0
  }
  let found = 0
  for (const p of scanProfiles) {
    const entries = ledger.profiles[p] ?? []
    const orphans = orphansByProfile[p] ?? []
    if (!entries.length && !orphans.length) continue
    process.stdout.write(`${p}:\n`)
    for (const e of entries) {
      found++
      process.stdout.write(
        `  - ${e.name ?? t('unknownName')} (id: ${e.id})\n${t('quarantinedAt', { time: e.quarantinedAt })}\n${t('reasonLine', { reason: e.reason })}\n${t('locationLine', { file: e.file })}\n`,
      )
    }
    for (const o of orphans) {
      found++
      process.stdout.write(`${t('listOrphanRow', { id: o.id, name: o.name ?? t('unknownName') })}\n`)
    }
    if (orphans.length) process.stdout.write(`${t('listOrphanHint')}\n`)
  }
  if (!found) process.stdout.write(profile ? `${t('noRecordsProfile', { profile })}\n` : `${t('noRecords')}\n`)
  return 0
}

function cmdRestore(args) {
  const [profile0, rest0] = takeProfile(args)
  const [ids0, rest1] = takeIds(rest0)
  const dryRun = rest1.includes('--dry-run')
  const all = rest1.includes('--all')
  if (!all && ids0.length === 0) {
    process.stderr.write(`${t('restoreNeedsId')}\n`)
    return 2
  }
  // 省略 --profile 时：--all 遍历台账 profile 与全部 profile 目录（孤儿托管
  // 区块可能存在于任何 profile——克隆产物台账里没有），否则只遍历台账里有
  // 记录的 profile（与 update 的恢复对齐）
  const ledger = loadLedger()
  const profiles = profile0
    ? [profile0]
    : all
      ? [...new Set([...Object.keys(ledger.profiles), ...profileDirs()])]
      : Object.keys(ledger.profiles).filter((p) => (ledger.profiles[p] ?? []).length)
  const verb = t(dryRun ? 'restoredDry' : 'restored')
  let anyRestored = false
  for (const p of profiles) {
    const { restored, kept } = restoreQuarantine(p, all ? 'all' : ids0, dryRun)
    for (const e of restored) process.stdout.write(`[dsh-safe] ${verb} ${e.name ?? e.id} (id: ${e.id})\n`)
    if (restored.length) {
      anyRestored = true
      if (kept.length) process.stdout.write(`${t('stillQuarantined', { profile: p, count: kept.length })}\n`)
      else process.stdout.write(`${t('ledgerCleared')}\n`)
    }
    // 孤儿托管区块：恢复后该 profile 台账已空，patch 里却仍有托管区块——
    // 区块由 dsh-safe 全权生成，台账为空即整体失效（克隆/手删台账的产物），
    // 直接摘除，让那些禁用行重新可见、可修复。
    const remaining = loadLedger().profiles[p] ?? []
    const block = managedBlockText(readIfExists(profilePatchPath(p)) ?? '')
    const orphans = block === null ? [] : scanPatchRows(block).filter((r) => !remaining.some((e) => e.id === r.id))
    if (orphans.length) {
      anyRestored = true
      const params = { profile: p, count: orphans.length }
      if (!dryRun) {
        writeFileSync(profilePatchPath(p), applyManagedBlock(readIfExists(profilePatchPath(p)), null).text)
      }
      process.stdout.write(`${t(dryRun ? 'orphanBlockRemovedDry' : 'orphanBlockRemoved', params)}\n`)
    }
  }
  if (!anyRestored) process.stdout.write(`${t('noMatching')}\n`)
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
  if (cmd === 'repair') return cmdRepair(argv.slice(1))
  if (cmd === 'update') return cmdUpdate(argv.slice(1))
  if (cmd === 'explain') return cmdExplain(argv.slice(1))
  if (cmd === 'doctor') {
    printDoctor()
    return 0
  }
  if (cmd === '-u' || cmd === '--update') return cmdUpdateAndBoot(argv.slice(1), { boot: runWrapperMode })
  // 0.15.0 起移除：保活由包装启动全权承担（隔离重试 + duplicate 自愈），
  // 修复走 repair 原语（用户手动或 web UI 里的 AI agent）。留一句迁移提示，
  // 避免老命令直接落进包装模式被 dsh 当成未知参数。
  if (cmd === '-r' || cmd === '--repair') {
    process.stderr.write(`${t('repairFlagRemoved')}\n`)
    return 2
  }

  // 包装模式：剥掉 dsh-safe 自己的旗标（必须出现在第一个位置参数之前），
  // 其余原样转发给 dsh。
  return runWrapperMode(argv)
}

/** 包装模式：剥离 dsh-safe 的旗标后运行 dsh；-u 升级完成后的启动也走这里。 */
async function runWrapperMode(argv) {
  maybeNotifySelfUpdate()
  const forwardArgs = []
  const excludeArgs = []
  let dryRun = false
  let maxRetries = 2
  let allowFirstParty = false
  let i = 0
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') { dryRun = true; continue }
    if (a === '--allow-first-party') { allowFirstParty = true; continue }
    if (a === '--exclude') { const v = argv[++i]; if (v !== undefined) excludeArgs.push(v); continue }
    if (a.startsWith('--exclude=')) { excludeArgs.push(a.slice('--exclude='.length)); continue }
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
  return runWrapped({ forwardArgs, dryRun, maxRetries, allowFirstParty, exclude: excludeArgs })
}
