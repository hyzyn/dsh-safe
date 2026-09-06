/**
 * @hyzyn/dsh-safe — 重复挂载（duplicate loader entry id）的去重。
 *
 * 同一 id 被多个 bundle 挂载时，加载器在 include 挂载阶段整体拒绝启动；
 * 它发生在 profile 层 disabled 覆盖合并之前，禁用行管不住，隔离无效。
 * 去重 = 保留一个来源，从 manifest bundles 移除其余来源（包本身保留在
 * node_modules，聚合包的挂载行仍解析到根安装的版本）。保留哪一个：
 * 交互终端让用户选；非交互（-y、dry-run、无 TTY）缺省保留官方 bundle
 * （@deepseek-ai/*，社区复刻与官方同 id 重复挂载时不能把官方挂载下线），
 * 没有官方来源则保留先声明者。第一方守卫：移除方案含官方 bundle 时，
 * 仅 allowFirstParty 或交互终端显式确认才放行，否则拒绝并由调用方给
 * 手动指引——移除一个 bundle 会把它挂载的其它条目一并卸载，官方 bundle
 * 背后往往是 webserver 等核心行。
 *
 * repair 与 wrap 两条路径共用：repair 负责额外的台账恢复，wrap 在启动
 * 失败自愈时调用。注意 dsh 会在每次 plugin add 时把 dependencies 里的
 * bundle 型包重新 reconcile 进 bundles——去重的成果可能被下一次 add
 * 复活，属于 dsh 的设计行为（见 repair/wrap 的调用处说明）。
 */
import { createInterface } from 'node:readline/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { profileManifestPath, readIfExists } from './dshpaths.js'
import { collectKnownRows } from './knownrows.js'
import { t } from './i18n.js'

const err = (line) => process.stderr.write(`${line}\n`)

export const FIRST_PARTY_PREFIX = '@deepseek-ai/'

/** 第一方（dsh 官方）包/bundle：@deepseek-ai/* 域下的名字。 */
export const isFirstParty = (name) => typeof name === 'string' && name.startsWith(FIRST_PARTY_PREFIX)

/** 该 id 的 bundle 挂载来源（profile/home 层是 override，不算挂载来源）。 */
export function bundleMountSources(known, id) {
  return [
    ...new Set(
      known.rows.filter((r) => r.id === id && r.source !== 'profile' && r.source !== 'home').map((r) => r.source),
    ),
  ]
}

/** 从 manifest bundles 移除指定来源；没有变化返回 false。 */
export function removeFromManifestBundles(profile, removeNames) {
  const manifestPath = profileManifestPath(profile)
  let manifest
  try {
    manifest = JSON.parse(readIfExists(manifestPath) ?? 'null')
  } catch {
    return false
  }
  const current = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(current)) return false
  const next = current.filter((b) => !removeNames.includes(b))
  if (next.length === current.length) return false
  manifest.dsh.profile.bundles = next
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return true
}

/**
 * 去重一个被多来源挂载的 id。
 * @param {string} profile
 * @param {string} id
 * @param {{
 *   yes?: boolean,   // 跳过交互选择（缺省保留官方来源，否则保留先声明者）
 *   tty?: boolean,   // 非交互终端不提示，直接按缺省来源去重（默认 false；
 *                    // 注意调用方传 undefined 也会落到默认值）
 *   dryRun?: boolean,
 *   allowFirstParty?: boolean,  // 允许移除官方 bundle（默认保护）
 *   log?: (line: string) => void,
 * }} [opts]
 * @returns {Promise<{ kept: string, removed: string[] } | { error: 'no-duplicate' | 'no-manifest' | 'first-party' }>}
 *   no-duplicate = 该 id 实际只有 ≤1 个可识别的挂载来源（扫描器盲区或已修复）
 *   first-party  = 保留方案会移除官方 bundle 且未获允许/确认
 */
export async function dedupeMountSources(
  profile,
  id,
  { yes = false, tty = false, dryRun = false, allowFirstParty = false, log = err } = {},
) {
  const sources = bundleMountSources(collectKnownRows(profile), id)
  if (sources.length < 2) return { error: 'no-duplicate' }

  // 按 manifest bundles 的声明顺序排序：先声明者优先保留
  let manifest
  try {
    manifest = JSON.parse(readIfExists(profileManifestPath(profile)) ?? 'null')
  } catch {
    manifest = null
  }
  const declared = manifest?.dsh?.profile?.bundles
  const ordered = Array.isArray(declared)
    ? [...sources].sort(
        (a, b) =>
          (declared.indexOf(a) < 0 ? 999 : declared.indexOf(a)) - (declared.indexOf(b) < 0 ? 999 : declared.indexOf(b)),
      )
    : sources

  // 缺省保留官方 bundle：社区复刻与官方同 id 重复挂载时，保官方、去社区
  const firstPartySources = ordered.filter(isFirstParty)
  const defaultKeep = firstPartySources.length ? firstPartySources[0] : ordered[0]

  let keep = defaultKeep
  if (!yes && !dryRun && tty) {
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    log(t('repairDedupePick', { id }))
    ordered.forEach((b, i) => log(`${i + 1}. ${b}${b === defaultKeep ? t('repairDedupeDefault') : ''}`))
    const answer = await rl.question(t('repairDedupeChoose'))
    rl.close()
    const fallback = ordered.indexOf(defaultKeep) + 1
    const pick = Math.min(Math.max(parseInt(answer, 10) || fallback, 1), ordered.length)
    keep = ordered[pick - 1]
  }
  const remove = ordered.filter((b) => b !== keep)

  log(t('repairDedupePlan', { keep, remove: remove.join(', '), id }))
  // 第一方守卫：移除官方 bundle 会连带卸载它挂载的其它条目（webserver 等
  // 核心行），仅在显式允许或交互确认后放行
  const removeFirstParty = remove.filter(isFirstParty)
  if (removeFirstParty.length && !allowFirstParty) {
    if (!yes && !dryRun && tty) {
      log(t('dedupeFirstPartyWarn', { bundles: removeFirstParty.join(', ') }))
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      const answer = await rl.question(t('dedupeFirstPartyConfirm'))
      rl.close()
      if (!/^(y|yes)$/i.test(answer.trim())) {
        log(t('dedupeFirstPartyBlocked', { bundles: removeFirstParty.join(', ') }))
        return { error: 'first-party' }
      }
    } else {
      log(t('dedupeFirstPartyBlocked', { bundles: removeFirstParty.join(', ') }))
      return { error: 'first-party' }
    }
  }
  if (dryRun) return { kept: keep, removed: remove }

  if (!removeFromManifestBundles(profile, remove)) return { error: 'no-manifest' }
  return { kept: keep, removed: remove }
}
