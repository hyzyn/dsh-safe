/**
 * @hyzyn/dsh-safe — `dsh-safe doctor`：环境体检。
 *
 * 汇总 self/dsh 版本、DSH_HOME、profiles、隔离台账、各 patch 文件的行数与
 * 托管区块状态、AI 开关、更新检查时间。纯只读，不改任何文件。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome, homePatchPath, profileDir, readIfExists, updateCheckFile } from './dshpaths.js'
import { loadLedger } from './quarantine.js'
import { MANAGED_START, scanPatchRows } from './patchfile.js'
import { resolveDshPackage, resolveSelfPackage } from './update.js'
import { aiEnabled } from './ai.js'
import { t } from './i18n.js'

export function printDoctor({ log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const self = resolveSelfPackage()
  log(t('doctorSelf', { version: self?.version ?? '?' }))
  const dsh = resolveDshPackage()
  log(dsh ? t('doctorDsh', { name: dsh.name, version: dsh.version }) : t('doctorDshMissing'))
  log(t('doctorHome', { home: dshHome() }))

  const profilesRoot = join(dshHome(), 'profiles')
  let profiles = []
  try {
    if (existsSync(profilesRoot)) {
      profiles = readdirSync(profilesRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    }
  } catch {}
  log(t('doctorProfiles', { profiles: profiles.join(', ') || '-' }))

  const ledger = loadLedger()
  const entries = Object.values(ledger.profiles).flat()
  if (entries.length) {
    const oldest = entries.map((e) => e.quarantinedAt).filter(Boolean).sort()[0] ?? '-'
    log(t('doctorLedger', { count: entries.length, oldest, profiles: Object.keys(ledger.profiles).join(', ') }))
  } else {
    log(t('doctorLedgerEmpty'))
  }

  for (const p of profiles) reportPatch(join(profileDir(p), 'cordis.patch.yml'), log)
  reportPatch(homePatchPath(), log)

  log(aiEnabled() ? t('doctorAIOn', { model: process.env.DSH_SAFE_AI_MODEL ?? 'deepseek-chat' }) : t('doctorAIOff'))

  let lastCheckAt
  try {
    lastCheckAt = JSON.parse(readIfExists(updateCheckFile()) ?? '{}')?.lastCheckAt
  } catch {}
  log(lastCheckAt ? t('doctorCheckLast', { time: lastCheckAt }) : t('doctorCheckNever'))
}

function reportPatch(path, log) {
  const text = readIfExists(path)
  if (text === undefined) {
    log(t('doctorPatchMissing', { file: path }))
    return
  }
  const rows = scanPatchRows(text)
  const managed = text.includes(MANAGED_START) ? '✓' : '—'
  log(t('doctorPatchOk', { file: path, rows: rows.length, managed }))
}
