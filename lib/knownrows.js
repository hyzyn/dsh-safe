/**
 * @hyzyn/dsh-safe — 收集一个 profile 下"行 id ↔ 插件包名"的对照表。
 *
 * 收集顺序 = dsh 的 patch 合成顺序（同 id 后写覆盖）：
 * 1. profile package.json `dsh.profile.bundles` 里每个 bundle 的 patch
 *    （只读对照；禁用行写入 profile 层——它在 bundle 层之后合成，同 id 覆盖 bundle 行）
 * 2. `$DSH_HOME/cordis.patch.yml` home 层
 * 3. profile 自己的 cordis.patch.yml（写层，dsh-safe 托管区块也在其中）
 *
 * 因此对照表数组里越靠后的行优先级越高：profile 层（含托管区块的 disabled 行）
 * 覆盖 home / bundle 层的同 id 行。
 */
import { join } from 'node:path'
import { scanPatchRows } from './patchfile.js'
import { homePatchPath, profileDir, profileManifestPath, profilePatchPath, readIfExists } from './dshpaths.js'

const readJsonIfExists = (path) => {
  const raw = readIfExists(path)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * @param {string} profile
 * @returns {{
 *   rows: Array<{ id: string, name: string|null, disabled: boolean, source: string, file: string }>,
 * }}
 */
export function collectKnownRows(profile) {
  const rows = []
  const profilePatch = profilePatchPath(profile)
  const homePatch = homePatchPath()

  const manifest = readJsonIfExists(profileManifestPath(profile))
  const bundles = manifest?.dsh?.profile?.bundles ?? []
  for (const bundle of bundles) {
    const bundleDir = join(profileDir(profile), 'node_modules', bundle)
    const pkg = readJsonIfExists(join(bundleDir, 'package.json'))
    const patchRel = pkg?.dsh?.bundle?.patch
    if (typeof patchRel !== 'string') continue
    const patchText = readIfExists(join(bundleDir, patchRel))
    if (patchText === undefined) continue
    for (const row of scanPatchRows(patchText)) rows.push({ ...row, source: bundle, file: profilePatch })
  }

  const homeText = readIfExists(homePatch)
  if (homeText !== undefined) {
    for (const row of scanPatchRows(homeText)) rows.push({ ...row, source: 'home', file: homePatch })
  }

  const profileText = readIfExists(profilePatch)
  if (profileText !== undefined) {
    for (const row of scanPatchRows(profileText)) rows.push({ ...row, source: 'profile', file: profilePatch })
  }

  return { rows, profilePatch, homePatch }
}

/**
 * 把失败报告对照到真实存在的 patch 行。
 * 包名命中该包的全部行（一个包可能挂多个 id）；行 id 命中对应行。
 * 同一 id 在多层重复出现时，取合成顺序里最后出现的行（profile/托管区块覆盖 home/bundle）。
 * @param {{ names: Array<[string, string]>, entryIds: Array<[string, string]> }} report
 * @param {{ rows: Array<{ id: string, name: string|null, disabled: boolean, file: string }> }} known
 * @returns {Array<{ id: string, name: string|null, disabled: boolean, file: string, line: string }>}
 */
export function matchFailures(report, known) {
  const byId = new Map()
  const byName = new Map()
  for (const row of known.rows) {
    byId.set(row.id, row) // 同 id 后写覆盖
    if (row.name) {
      if (!byName.has(row.name)) byName.set(row.name, [])
      byName.get(row.name).push(row)
    }
  }
  const hits = new Map()
  for (const [name, line] of report.names) {
    for (const row of byName.get(name) ?? []) hits.set(row.id, { ...row, line })
  }
  for (const [id, line] of report.entryIds) {
    const row = byId.get(id)
    if (row) hits.set(row.id, { ...row, line })
  }
  return [...hits.values()]
}
