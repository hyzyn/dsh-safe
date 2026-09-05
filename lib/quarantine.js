/**
 * @hyzyn/dsh-safe — 隔离台账与 patch 文件写入。
 *
 * 台账：`$DSH_HOME/dsh-safe/quarantine.json`，按 profile 记录被自动禁用的行
 * （id/name/reason/时间/所在文件）。patch 文件的改动只体现为末尾的托管区块
 * （带标记注释，可重复生成、可整体摘除），用户已有内容与注释原样保留。
 *
 * 同一个 patch 文件（如 `$DSH_HOME/cordis.patch.yml`）可能被多个 profile 的
 * 隔离记录共享：托管区块始终按"文件"聚合全部 profile 的台账条目重新生成，
 * 避免一次写入覆盖另一个 profile 的区块。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { applyManagedBlock, buildManagedBlock } from './patchfile.js'
import { ledgerFile, readIfExists } from './dshpaths.js'

const EMPTY_LEDGER = () => ({ version: 1, profiles: {} })

export function loadLedger() {
  const raw = readIfExists(ledgerFile())
  if (raw === undefined) return EMPTY_LEDGER()
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.profiles && typeof parsed.profiles === 'object') {
      return { version: 1, profiles: parsed.profiles }
    }
  } catch {}
  return EMPTY_LEDGER()
}

export function saveLedger(ledger) {
  const file = ledgerFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`)
}

/** 重写指定 patch 文件的托管区块（跨 profile 聚合；extraFiles 兜底清空的文件）。 */
function rewriteManagedBlocks(ledger, extraFiles = []) {
  const all = Object.values(ledger.profiles).flat()
  const files = new Set([...all.map((e) => e.file), ...extraFiles])
  for (const file of files) {
    const entries = all.filter((e) => e.file === file)
    const text = readIfExists(file)
    if (text === undefined) continue
    const { text: next } = applyManagedBlock(text, entries.length ? buildManagedBlock(entries) : null)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, next)
  }
}

/**
 * 把要禁用的行写入对应 patch 文件的托管区块，并更新台账。
 * @param {string} profile
 * @param {Array<{ id: string, name: string|null, reason: string, file: string }>} targets
 * @param {boolean} dryRun
 * @param {string} now ISO 时间戳
 * @returns {{ ledger: object }} 更新后的台账
 */
export function writeQuarantine(profile, targets, dryRun, now = new Date().toISOString()) {
  const ledger = loadLedger()
  const list = (ledger.profiles[profile] ??= [])
  for (const t of targets) {
    const existing = list.find((e) => e.id === t.id && e.file === t.file)
    if (existing) {
      existing.reason = t.reason
      existing.quarantinedAt = now
    } else {
      list.push({ id: t.id, name: t.name ?? null, reason: t.reason, quarantinedAt: now, file: t.file })
    }
  }
  if (!dryRun) {
    rewriteManagedBlocks(ledger)
    saveLedger(ledger)
  }
  return { ledger }
}

/**
 * 恢复（摘除）被禁用的行：从台账删除并按剩余台账重写托管区块。
 * @param {string} profile
 * @param {string[] | 'all'} ids
 * @param {boolean} dryRun
 * @returns {{ restored: Array<object>, kept: Array<object> }}
 */
export function restoreQuarantine(profile, ids, dryRun) {
  const ledger = loadLedger()
  const list = ledger.profiles[profile] ?? []
  if (!list.length) return { restored: [], kept: [] }
  const removeSet = ids === 'all' ? new Set(list.map((e) => e.id)) : new Set(ids)
  const kept = list.filter((e) => !removeSet.has(e.id))
  const restored = list.filter((e) => removeSet.has(e.id))
  if (!dryRun) {
    if (kept.length) ledger.profiles[profile] = kept
    else delete ledger.profiles[profile]
    rewriteManagedBlocks(ledger, restored.map((e) => e.file))
    saveLedger(ledger)
  }
  return { restored, kept }
}
