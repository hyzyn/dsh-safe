/**
 * @hyzyn/dsh-safe — 收集一个 profile 下"行 id ↔ 插件包名"的对照表。
 *
 * 来源（后写的层优先级更高）：
 * 1. profile 自己的 cordis.patch.yml（写层）
 * 2. `$DSH_HOME/cordis.patch.yml` home 层（写层：发现的行写回 home patch）
 * 3. profile package.json `dsh.profile.bundles` 里每个 bundle 的 patch
 *    （只读对照；禁用行写入 profile 层，它在 bundle 层之后合成，同 id 后写覆盖）
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

  const profileText = readIfExists(profilePatch)
  if (profileText !== undefined) {
    for (const row of scanPatchRows(profileText)) rows.push({ ...row, source: 'profile', file: profilePatch })
  }

  const homeText = readIfExists(homePatch)
  if (homeText !== undefined) {
    for (const row of scanPatchRows(homeText)) rows.push({ ...row, source: 'home', file: homePatch })
  }

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

  return { rows, profilePatch, homePatch }
}

/**
 * 把失败报告对照到真实存在的 patch 行。
 * 包名命中该包的全部行（一个包可能挂多个 id）；行 id 命中对应行。
 * @param {{ names: Array<[string, string]>, entryIds: Array<[string, string]> }} report
 * @param {{ rows: Array<{ id: string, name: string|null, disabled: boolean, file: string }> }} known
 * @returns {Array<{ id: string, name: string|null, disabled: boolean, file: string, line: string }>}
 */
export function matchFailures(report, known) {
  const byId = new Map()
  const byName = new Map()
  for (const row of known.rows) {
    if (!byId.has(row.id)) byId.set(row.id, row)
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
