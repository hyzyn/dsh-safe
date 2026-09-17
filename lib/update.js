/**
 * @hyzyn/dsh-safe — `dsh-safe update`：升级 dsh 并自动恢复被隔离的插件。
 *
 * 自动探测：PATH 上的 dsh 可执行文件 realpath → 向上找最近的 package.json
 * 得到包名与当前版本；包管理器按 realpath 是否落在 pnpm 全局根下判定
 * （PATH 上有 pnpm 时探测，否则默认 npm），--pm 可强制指定。
 * 升级完成后遍历台账恢复全部被隔离的插件（新 dsh 下仍不兼容的会在
 * 下次启动时再次被自动隔离），并提示回滚方式。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { dirname } from 'node:path'
import { resolveDshPackage, resolveSelfPackage, spawnPmCapture, spawnPmInherit, whichCmd } from './dshpkg.js'
import { loadLedger, restoreQuarantine } from './quarantine.js'
import { readIfExists, updateCheckFile } from './dshpaths.js'
import { verifyParser } from './verify.js'
import { t } from './i18n.js'

const err = (line) => process.stderr.write(`${line}\n`)
const out = (line) => process.stdout.write(`${line}\n`)

const readJsonIfExists = (path) => {
  const raw = readIfExists(path)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

/** 更新检查与启动期提示的总开关（显式 update / --check 不受它约束）。 */
const noUpdateCheck = () => process.env.DSH_SAFE_NO_UPDATE_CHECK === '1'

/** 读更新检查状态（$DSH_HOME/dsh-safe/update-check.json）；缺失或损坏按空处理。 */
function readCheckState() {
  return readJsonIfExists(updateCheckFile()) ?? {}
}

/** 读-改-写更新检查状态（保留其他键），任何失败完全静默——状态文件不值得影响主流程。 */
function patchCheckState(patch) {
  try {
    const file = updateCheckFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ ...readCheckState(), ...patch }, null, 2)}\n`)
  } catch {}
}

/**
 * 每日一次的通知闸：key 是状态文件里的时间戳字段名。到期（或从未记过）则
 * 立刻占位并返回 true；未到期返回 false。与 lastCheckAt 共用同一份状态。
 */
function takeDailySlot(key) {
  const last = readCheckState()[key]
  if (last && Date.now() - Date.parse(last) < DAY_MS) return false
  patchCheckState({ [key]: new Date().toISOString() })
  return true
}

/** 判断 dsh 的安装方式：落在 pnpm 全局根下则为 pnpm，否则 npm。 */
export function detectPm(pkgDir) {
  const pnpmBin = whichCmd('pnpm')
  if (!pnpmBin) return 'npm'
  const { status, stdout } = spawnPmCapture(pnpmBin, ['root', '-g'])
  const root = status === 0 ? (stdout ?? '').trim() : ''
  if (root && (pkgDir === root || pkgDir.startsWith(`${root}/`) || pkgDir.startsWith(`${root}\\`))) return 'pnpm'
  return 'npm'
}

/**
 * npm view 查各通道版本（latest/next/alpha…），失败返回 null。
 * 一次调用同时拿到 latest 与 next，供"latest 已最新但 next 更新"的提示用，
 * 不额外增加网络往返。只保留形似版本号的字符串值，脏数据按缺失处理。
 */
function fetchDistTags(name) {
  const { status, stdout } = spawnPmCapture(whichCmd('npm') ?? 'npm', ['view', name, 'dist-tags', '--json'])
  if (status !== 0) return null
  let parsed
  try {
    parsed = JSON.parse(stdout ?? '')
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const tags = {}
  for (const [tag, version] of Object.entries(parsed)) {
    if (typeof version === 'string' && /^[\w.+-]+$/.test(version)) tags[tag] = version
  }
  return tags
}

/** npm view 查 latest 通道版本（只查 registry，与安装方式无关），失败返回 null。 */
function fetchLatestVersion(name) {
  return fetchDistTags(name)?.latest ?? null
}

/**
 * 比较 semver 风格版本：a > b 返回 true（零依赖的够用版）。
 * 核心段按数字逐段比较；核心相同时正式版 > 预发布，预发布逐段比较（数字段按数值）。
 * 自动检查用它避免"registry 落后于本地开发版"时的自降级；--to 显式指定不走这里，允许降级回滚。
 */
export function isNewerVersion(a, b) {
  if (a === b) return false
  const [aCore, aPre] = String(a).split('-', 2)
  const [bCore, bPre] = String(b).split('-', 2)
  const pa = aCore.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = bCore.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  if (aPre && !bPre) return false
  if (!aPre && bPre) return true
  const qa = (aPre ?? '').split('.')
  const qb = (bPre ?? '').split('.')
  for (let i = 0; i < Math.max(qa.length, qb.length); i++) {
    const x = qa[i]
    const y = qb[i]
    if (x === undefined) return false
    if (y === undefined) return true
    const numericX = /^\d+$/.test(x)
    const numericY = /^\d+$/.test(y)
    if (numericX && numericY) {
      const d = Number(x) - Number(y)
      if (d) return d > 0
    } else if (x !== y) {
      return x > y
    }
  }
  return false
}

/**
 * latest 之外的通道差距：从 dist-tags 里挑出**所有**比"将装到的版本"更新的通道。
 * 通道名不写死——上游的未发布通道不止 next（还有 alpha/beta/canary…），只排除 latest。
 * 每个都要报：曾经只报版本最高的那个，结果 next(0.1.5-rc.2) 被 alpha(0.1.6-alpha.1)
 * 盖掉，跟着 next 的人以为提示丢了。返回按版本升序（同版本按通道名字典序，与 registry
 * 返回的键顺序无关）。比较用 isNewerVersion，所以同一核心版本的预发布
 * （1.2.3-alpha.1 对 1.2.3）不会被误报成"有更新"。
 * @param {Record<string, string> | null | undefined} tags
 * @param {string | null | undefined} target 将装到的版本（或当前版本）
 * @returns {Array<{ tag: string, version: string }>}
 */
export function channelGaps(tags, target) {
  if (!tags || !target) return []
  const gaps = []
  for (const [tag, version] of Object.entries(tags)) {
    if (tag === 'latest') continue
    if (!isNewerVersion(version, target)) continue
    gaps.push({ tag, version })
  }
  return gaps.sort((a, b) => {
    if (a.version !== b.version) return isNewerVersion(a.version, b.version) ? 1 : -1
    return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0
  })
}

/**
 * @param {string[]} args update 子命令参数
 * @returns {Promise<number>} 退出码
 */
export async function cmdUpdate(args) {
  if (args.includes('-h') || args.includes('--help')) {
    out(t('helpText', {}))
    return 0
  }
  const { opts, error } = parseUpdateArgs(args)
  if (error) {
    err(t(error.key, error.params))
    return 2
  }
  return updateAndMaybeBoot(opts, null, {})
}

/**
 * `-u`/`--update` 模式：前缀解析 update 选项（-y/--to/--pm/--no-restore），
 * 第一个不属于 update 的参数起就是 dsh 启动参数（可再带包装旗标）。
 * 启动优先：更新检查失败只告警并照常启动；升级失败/用户取消则不启动。
 * @param {string[]} args
 * @param {{ boot?: (args: string[]) => Promise<number> }} hooks cli 传入的包装启动
 */
export async function cmdUpdateAndBoot(args, { boot } = {}) {
  if (args.includes('-h') || args.includes('--help')) {
    out(t('helpText', {}))
    return 0
  }
  const { opts, rest, error } = parseLeadingUpdateArgs(args)
  if (error) {
    err(t(error.key, error.params))
    return 2
  }
  return updateAndMaybeBoot(opts, rest.length ? rest : null, { boot })
}

/**
 * 更新主体；bootArgs 非空时更新成功（或已最新/检查失败）后继续启动。
 * 默认同时检查 dsh 与 dsh-safe 自身，谁旧升谁（一条安装命令）；--self 只更新自身。
 * dsh 更新成功后默认跑解析器自校验（--no-verify 跳过）。
 * --check 只报告计划（含 latest 之外的通道差距）就返回，不提示、不安装、不启动。
 * @param {{ to?: string, yes?: boolean, restore?: boolean, pm?: string, selfOnly?: boolean, noVerify?: boolean, check?: boolean }} opts
 * @param {string[] | null} bootArgs
 * @param {{ boot?: (args: string[]) => Promise<number>, verify?: typeof verifyParser }} hooks
 */
async function updateAndMaybeBoot(opts, bootArgs, { boot, verify = verifyParser } = {}) {
  const dshPkg = opts.selfOnly ? null : resolveDshPackage()
  const selfPkg = resolveSelfPackage()
  if (!dshPkg && !selfPkg) {
    err(t('updateDshNotFound'))
    return 1
  }
  const pm = opts.pm ?? (dshPkg ? detectPm(dshPkg.pkgDir) : detectPm(selfPkg.pkgDir))

  // 组装更新计划：[{ pkg, target }]；dshTags 另供通道提示（--to 显式指定目标时不查）
  const plans = []
  let dshTags = null
  if (dshPkg) {
    if (opts.to) {
      if (opts.to !== dshPkg.version) plans.push({ pkg: dshPkg, target: opts.to })
    } else {
      dshTags = fetchDistTags(dshPkg.name)
      const latest = dshTags?.latest
      if (!latest) {
        if (bootArgs && !opts.check) {
          err(t('updateSkipCheckWarn', { pm }))
          return boot(bootArgs)
        }
        err(t('updateLatestFetchFail', { name: dshPkg.name, pm }))
        return 1
      }
      if (isNewerVersion(latest, dshPkg.version)) plans.push({ pkg: dshPkg, target: latest })
    }
  }
  if (selfPkg && !opts.to) {
    const selfLatest = fetchLatestVersion(selfPkg.name)
    if (selfLatest && isNewerVersion(selfLatest, selfPkg.version)) plans.push({ pkg: selfPkg, target: selfLatest })
  }

  // latest 之外的通道差距（alpha / next 等任一通道比"将装到的版本"更新时给一条指引）。
  // 只提示，绝不自动安装——dsh-safe 不替用户决定上未发布通道。曾经在启动路径上做过
  // 「每天最多一次」的闸，但同一个仓库的裸 -u 每次都说、加了 dsh 参数就沉默，
  // 用户看到的是"时有时无"，于是取消闸：-u / update / --check 一视同仁，每次都报。
  // 想彻底安静就用 DSH_SAFE_NO_UPDATE_CHECK=1（只作用于启动路径，显式调用不受影响）。
  const bootNotice = Boolean(bootArgs) && !opts.check
  const notifyChannelGap = () => {
    if (bootNotice && noUpdateCheck()) return
    if (!dshPkg) return
    const target = plans.find((p) => p.pkg === dshPkg)?.target ?? dshPkg.version
    for (const gap of channelGaps(dshTags, target)) {
      err(t('updateChannelHint', { tag: gap.tag, version: gap.version, current: target }))
    }
  }

  if (!plans.length) {
    // 启动路径与显式调用报同一份状态（"已是最新" + 通道差距），不再静默启动。
    if (bootArgs && !opts.check) {
      if (!noUpdateCheck()) {
        err(t('updateAlreadyLatest', { dsh: dshPkg?.version ?? '未安装', self: selfPkg?.version ?? '未知' }))
      }
      notifyChannelGap()
      return boot(bootArgs)
    }
    err(t('updateAlreadyLatest', { dsh: dshPkg?.version ?? '未安装', self: selfPkg?.version ?? '未知' }))
    notifyChannelGap()
    return 0
  }

  const installCmd = pm === 'pnpm' ? 'pnpm' : 'npm'
  const specs = plans.map((p) => `${p.pkg.name}@${p.target}`)
  const installArgs =
    pm === 'pnpm' ? ['add', '-g', ...specs] : ['install', '-g', ...specs]
  for (const p of plans) {
    err(t('updatePlan', { label: p.pkg === dshPkg ? 'dsh' : 'dsh-safe', name: p.pkg.name, old: p.pkg.version, target: p.target, pm }))
  }
  notifyChannelGap()
  if (opts.check) {
    err(t('updateCheckWouldRun', { command: `${installCmd} ${installArgs.join(' ')}` }))
    return 0
  }
  err(t('updateInstallCmd', { command: `${installCmd} ${installArgs.join(' ')}` }))
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      err(t('updateNonInteractive'))
      return 1
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    const answer = (await rl.question(t('updateConfirm'))).trim().toLowerCase()
    rl.close()
    if (answer !== 'y' && answer !== 'yes') {
      err(t('updateAborted'))
      return 0
    }
  }

  err(t('updateInstalling'))
  const { status } = spawnPmInherit(whichCmd(installCmd) ?? installCmd, installArgs)
  if (status !== 0) {
    err(t('updateInstallFail', { code: status ?? '?' }))
    return status ?? 1
  }

  let dshUpdated = false
  for (const p of plans) {
    if (p.pkg === dshPkg) {
      dshUpdated = true
      const fresh = resolveDshPackage()
      if (!fresh?.version) err(t('updateVerifyWarn'))
      else err(t('updateDone', { old: p.pkg.version, new: fresh.version }))
    } else {
      err(t('selfUpdateLagHint', { old: p.pkg.version, new: p.target }))
    }
  }
  if (dshUpdated && !opts.noVerify) {
    await verify({ rollbackVersion: plans.find((p) => p.pkg === dshPkg)?.pkg.version, log: err })
  }

  if (opts.restore && dshUpdated) {
    const ledger = loadLedger()
    const profiles = Object.keys(ledger.profiles).filter((p) => (ledger.profiles[p] ?? []).length)
    if (!profiles.length) {
      out(t('updateNothingToRestore'))
    } else {
      for (const profile of profiles) {
        const { restored } = restoreQuarantine(profile, 'all', false)
        if (restored.length) out(t('updateRestoredProfile', { profile, count: restored.length }))
      }
      err(t('updateVerifyHint'))
    }
  } else if (dshUpdated && !opts.restore) {
    err(t('updateRestoreSkipped'))
  }
  if (dshUpdated) {
    const oldDsh = plans.find((p) => p.pkg === dshPkg)?.pkg.version
    if (oldDsh) err(t('updateRollbackHint', { version: oldDsh }))
  }
  if (bootArgs) return boot(bootArgs)
  return 0
}

/** 解析 update 子命令参数；出错返回 { error: { key, params? } } 供 i18n。 */
function parseUpdateArgs(args) {
  const opts = { to: undefined, yes: false, restore: true, pm: undefined, selfOnly: false, noVerify: false, check: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-y' || a === '--yes') opts.yes = true
    else if (a === '--no-restore') opts.restore = false
    else if (a === '--self') opts.selfOnly = true
    else if (a === '--no-verify') opts.noVerify = true
    else if (a === '--check') opts.check = true
    else if (a === '--to') {
      const v = args[++i]
      if (v === undefined) return { error: { key: 'updateUnknownFlag', params: { arg: '--to' } } }
      opts.to = v
    } else if (a.startsWith('--to=')) opts.to = a.slice('--to='.length)
    else if (a === '--pm') {
      const v = args[++i]
      if (v === undefined) return { error: { key: 'updateUnknownFlag', params: { arg: '--pm' } } }
      opts.pm = v
    } else if (a.startsWith('--pm=')) opts.pm = a.slice('--pm='.length)
    else return { error: { key: 'updateUnknownFlag', params: { arg: a } } }
  }
  if (opts.pm !== undefined && opts.pm !== 'npm' && opts.pm !== 'pnpm') {
    return { error: { key: 'updatePmInvalid' } }
  }
  if (opts.to !== undefined && !/^[\w.+-]+$/.test(opts.to)) {
    return { error: { key: 'updateToInvalid' } }
  }
  return { opts }
}

/**
 * `-u` 模式的前缀解析：从头吃掉 update 选项，第一个不认识的参数起就是
 * dsh 启动参数（宽松处理——不像子命令那样对未知参数报错）。
 */
function parseLeadingUpdateArgs(args) {
  const opts = { to: undefined, yes: false, restore: true, pm: undefined, selfOnly: false, noVerify: false, check: false }
  let i = 0
  for (; i < args.length; i++) {
    const a = args[i]
    if (a === '-y' || a === '--yes') opts.yes = true
    else if (a === '--no-restore') opts.restore = false
    else if (a === '--self') opts.selfOnly = true
    else if (a === '--no-verify') opts.noVerify = true
    else if (a === '--check') opts.check = true
    else if (a === '--to' && args[i + 1] !== undefined) opts.to = args[++i]
    else if (a.startsWith('--to=')) opts.to = a.slice('--to='.length)
    else if (a === '--pm' && args[i + 1] !== undefined) opts.pm = args[++i]
    else if (a.startsWith('--pm=')) opts.pm = a.slice('--pm='.length)
    else break
  }
  const rest = args.slice(i)
  if (opts.pm !== undefined && opts.pm !== 'npm' && opts.pm !== 'pnpm') {
    return { error: { key: 'updatePmInvalid' } }
  }
  if (opts.to !== undefined && !/^[\w.+-]+$/.test(opts.to)) {
    return { error: { key: 'updateToInvalid' } }
  }
  return { opts, rest }
}

/**
 * 每日一次的 dsh-safe 新版提示（只在包装启动路径调用；update/-u 有自己的检查）。
 * 时间戳记在 $DSH_HOME/dsh-safe/update-check.json（与 dsh 通道提示共用，读-改-写）；
 * 任何失败都完全静默。
 */
export function maybeNotifySelfUpdate() {
  try {
    if (noUpdateCheck()) return
    const selfPkg = resolveSelfPackage()
    if (!selfPkg) return
    if (!takeDailySlot('lastCheckAt')) return
    const latest = fetchLatestVersion(selfPkg.name)
    if (latest && isNewerVersion(latest, selfPkg.version)) {
      err(t('updateNotify', { new: latest, old: selfPkg.version }))
      err(t('updateNotifyHow', { name: selfPkg.name }))
    }
  } catch {}
}
