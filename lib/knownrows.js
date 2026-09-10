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
import { dshInstallNodeModules } from './dshpkg.js'
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
 * bundle 的候选安装目录：profile 自己的 node_modules 优先，其次是 dsh 安装目录下的。
 * 官方 bundle（dsh-base、dsh-web-app 等）装在后者——dsh 用它自己的模块解析加载它们，
 * 只按 profile 目录找会把官方 bundle 的行整表漏掉，官方行的包名随之丢失。
 */
function bundleDirCandidates(profile, bundle) {
  const segments = bundle.split('/')
  return [
    { dir: join(profileDir(profile), 'node_modules', ...segments), internal: false },
    ...dshInstallNodeModules().map((nodeModules) => ({ dir: join(nodeModules, ...segments), internal: true })),
  ]
}

/**
 * @param {string} profile
 * @returns {{
 *   rows: Array<{ id: string, name: string|null, disabled: boolean, source: string, file: string, internal?: boolean }>,
 * }}
 *   internal 的行来自 dsh 安装目录里的官方 bundle：只用于包名/来源解析，不参与
 *   duplicate 来源判定（见 dedupe.bundleMountSources、repair 的重复预检）。
 */
export function collectKnownRows(profile) {
  const rows = []
  const profilePatch = profilePatchPath(profile)
  const homePatch = homePatchPath()

  const manifest = readJsonIfExists(profileManifestPath(profile))
  const bundles = manifest?.dsh?.profile?.bundles ?? []
  for (const bundle of bundles) {
    // 候选按优先级取第一个真实存在的包；找到包但没声明 patch / 读不到 patch 时不再
    // 往下试（同一个 bundle 不会在两处各装一份不同内容）
    for (const candidate of bundleDirCandidates(profile, bundle)) {
      const pkg = readJsonIfExists(join(candidate.dir, 'package.json'))
      if (!pkg) continue
      const patchRel = pkg?.dsh?.bundle?.patch
      if (typeof patchRel !== 'string') break
      const patchText = readIfExists(join(candidate.dir, patchRel))
      if (patchText === undefined) break
      for (const row of scanPatchRows(patchText)) {
        rows.push({
          ...row,
          source: bundle,
          file: profilePatch,
          ...(candidate.internal ? { internal: true } : {}),
        })
      }
      break
    }
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
 * 该行没有包名时，依次回退到：(1) 同 id 其它层行声明的包名（合成顺序里最后一个
 * 非空者）；(2) 报错同一行里解析出的包名。profile 覆盖行通常只写 config 不重述
 * name（如 webserver 的 host/port 覆盖），若照搬本层行会把包名丢成 null，wrap 的
 * 第一方保护（@deepseek-ai/* 前缀）随之失效、误禁官方插件。
 * 回退 (2) 是必须的：真实 profile 里可能没有任何层声明该 id 的 name（web profile
 * 的 webserver 就是如此——它由 bundle 的 insert 挂载，profile 只写 host/port 覆盖），
 * 此时包名只存在于 dsh 的报错文本里，不回退就仍会以 name=null 绕过第一方保护。
 * @param {{ names: Array<[string, string]>, entryIds: Array<[string, string]> }} report
 * @param {{ rows: Array<{ id: string, name: string|null, disabled: boolean, file: string }> }} known
 * @returns {Array<{ id: string, name: string|null, disabled: boolean, file: string, line: string }>}
 */
export function matchFailures(report, known) {
  const byId = new Map()
  const byName = new Map()
  const nameById = new Map()
  for (const row of known.rows) {
    byId.set(row.id, row) // 同 id 后写覆盖
    if (row.name) {
      nameById.set(row.id, row.name)
      if (!byName.has(row.name)) byName.set(row.name, [])
      byName.get(row.name).push(row)
    }
  }
  // 报错行 → 该行解析出的包名。按 id 命中时用它兜底：patch 行没写 name、其它层也
  // 没有同名 id 行时，包名就只剩报错里这一个来源（见上方说明）。
  const nameByLine = new Map(report.names.map(([name, line]) => [line, name]))
  const hits = new Map()
  for (const [name, line] of report.names) {
    for (const row of byName.get(name) ?? []) hits.set(row.id, { ...row, line })
  }
  for (const [id, line] of report.entryIds) {
    const row = byId.get(id)
    if (row) hits.set(row.id, { ...row, name: row.name ?? nameById.get(id) ?? nameByLine.get(line) ?? null, line })
  }
  return [...hits.values()]
}
