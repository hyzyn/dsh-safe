/**
 * @hyzyn/dsh-safe — `dsh-safe update`：升级 dsh 并自动恢复被隔离的插件。
 *
 * 自动探测：PATH 上的 dsh 可执行文件 realpath → 向上找最近的 package.json
 * 得到包名与当前版本；包管理器按 realpath 是否落在 pnpm 全局根下判定
 * （PATH 上有 pnpm 时探测，否则默认 npm），--pm 可强制指定。
 * 升级完成后遍历台账恢复全部被隔离的插件（新 dsh 下仍不兼容的会在
 * 下次启动时再次被自动隔离），并提示回滚方式。
 */
import { accessSync, constants, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { delimiter, dirname, join } from 'node:path'
import { loadLedger, restoreQuarantine } from './quarantine.js'
import { readIfExists, updateCheckFile } from './dshpaths.js'
import { t } from './i18n.js'

const err = (line) => process.stderr.write(`${line}\n`)
const out = (line) => process.stdout.write(`${line}\n`)

const WIN32 = process.platform === 'win32'

/**
 * 运行包管理器命令并捕获输出（view / pnpm root -g）。
 * Windows 上 npm/pnpm 是 .cmd 批处理，Node 禁止无 shell 地 spawn（EINVAL），
 * 必须走 cmd.exe；传参只含已校验的包名与版本号（--to 有 ^[\w.+-]+$ 校验）。
 */
function spawnPmCapture(bin, args) {
  return WIN32
    ? spawnSync(bin, args, { encoding: 'utf8', shell: true })
    : spawnSync(bin, args, { encoding: 'utf8' })
}

/** 运行包管理器命令并透传 stdio（install）。Windows 处理同上。 */
function spawnPmInherit(bin, args) {
  return WIN32
    ? spawnSync(bin, args, { shell: true, stdio: 'inherit' })
    : spawnSync(bin, args, { stdio: 'inherit' })
}

/** Windows 上全局 bin 的可执行是 .cmd/.exe 拷贝而非 symlink，候选名不同。 */
function binCandidates(name) {
  return WIN32 ? [`${name}.cmd`, `${name}.exe`, `${name}.ps1`, name] : [name]
}

const readJsonIfExists = (path) => {
  const raw = readIfExists(path)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** 在 PATH 上找可执行文件（Windows 展开为 .cmd/.exe/.ps1/裸名多候选），返回绝对路径或 null。 */
function whichCmd(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const candidate of binCandidates(name).map((n) => join(dir, n))) {
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {}
    }
  }
  return null
}

/** 从某个目录向上找最近的 package.json，返回 { name, version, pkgDir }。 */
function resolvePackageFromDir(dir) {
  for (;;) {
    const pkg = readJsonIfExists(join(dir, 'package.json'))
    if (pkg && typeof pkg.name === 'string' && pkg.name) {
      return { name: pkg.name, version: typeof pkg.version === 'string' ? pkg.version : '0.0.0', pkgDir: dir }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * 从可执行文件解析所属包：symlink → realpath 后向上找 package.json（macOS/Linux
 * 的 npm/pnpm 全局 bin 都是链接）；独立 shim 文件（Windows 的 .cmd/sh 拷贝）→
 * 解析其内容里内嵌的 node_modules 入口路径。
 */
function resolvePackageFromBinFile(file) {
  let real
  try {
    real = realpathSync(file)
  } catch {
    return null
  }
  const viaWalkUp = resolvePackageFromDir(dirname(real))
  if (viaWalkUp) return viaWalkUp
  return resolvePackageFromShim(file)
}

/** 解析 npm/pnpm 的 cmd/ps1/sh shim：内容里都内嵌 node_modules/<pkg> 的入口路径。 */
export function resolvePackageFromShim(shimPath) {
  const content = readIfExists(shimPath)
  if (!content) return null
  const m = /node_modules[\\\/]((?:@[^\\\/"'`\s]+[\\\/])?[^\\\/"'`\s]+)/.exec(content)
  if (!m) return null
  const name = m[1].replace(/[\\\/]/g, '/')
  // 候选 pkgDir：npm 全局布局（shim 同级的 node_modules）与 pnpm 全局根
  const candidates = [join(dirname(shimPath), 'node_modules', ...name.split('/'))]
  const pnpmBin = whichCmd('pnpm')
  if (pnpmBin) {
    const { status, stdout } = spawnPmCapture(pnpmBin, ['root', '-g'])
    const root = status === 0 ? (stdout ?? '').trim() : ''
    if (root) candidates.push(join(root, ...name.split('/')))
  }
  for (const dir of candidates) {
    const pkg = readJsonIfExists(join(dir, 'package.json'))
    if (pkg?.name === name) {
      return { name, version: typeof pkg.version === 'string' ? pkg.version : '0.0.0', pkgDir: dir }
    }
  }
  return null
}

/**
 * 解析 PATH 上的 dsh。
 * @returns {{ name: string, version: string, pkgDir: string } | null}
 */
export function resolveDshPackage() {
  const bin = whichCmd('dsh')
  if (!bin) return null
  return resolvePackageFromBinFile(bin)
}

/**
 * 解析正在运行的 dsh-safe 自身（argv[1]，npm/pnpm 全局 bin symlink 或仓库内直跑均适用）。
 * @returns {{ name: string, version: string, pkgDir: string } | null}
 */
export function resolveSelfPackage() {
  const entry = process.argv[1]
  if (!entry) return null
  return resolvePackageFromBinFile(entry)
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

/** npm view 查最新版本（只查 registry，与安装方式无关），失败返回 null。 */
function fetchLatestVersion(name) {
  const { status, stdout } = spawnPmCapture(whichCmd('npm') ?? 'npm', ['view', name, 'version'])
  const version = status === 0 ? (stdout ?? '').trim() : ''
  return /^[\w.+-]+$/.test(version) ? version : null
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
 * @param {{ to?: string, yes?: boolean, restore?: boolean, pm?: string, selfOnly?: boolean }} opts
 * @param {string[] | null} bootArgs
 * @param {{ boot?: (args: string[]) => Promise<number> }} hooks
 */
async function updateAndMaybeBoot(opts, bootArgs, { boot } = {}) {
  const dshPkg = opts.selfOnly ? null : resolveDshPackage()
  const selfPkg = resolveSelfPackage()
  if (!dshPkg && !selfPkg) {
    err(t('updateDshNotFound'))
    return 1
  }
  const pm = opts.pm ?? (dshPkg ? detectPm(dshPkg.pkgDir) : detectPm(selfPkg.pkgDir))

  // 组装更新计划：[{ pkg, target }]
  const plans = []
  if (dshPkg) {
    if (opts.to) {
      if (opts.to !== dshPkg.version) plans.push({ pkg: dshPkg, target: opts.to })
    } else {
      const latest = fetchLatestVersion(dshPkg.name)
      if (!latest) {
        if (bootArgs) {
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

  if (!plans.length) {
    if (bootArgs) return boot(bootArgs)
    err(t('updateAlreadyLatest', { dsh: dshPkg?.version ?? '未安装', self: selfPkg?.version ?? '未知' }))
    return 0
  }

  const installCmd = pm === 'pnpm' ? 'pnpm' : 'npm'
  const specs = plans.map((p) => `${p.pkg.name}@${p.target}`)
  const installArgs =
    pm === 'pnpm' ? ['add', '-g', ...specs] : ['install', '-g', ...specs]
  for (const p of plans) {
    err(t('updatePlan', { label: p.pkg === dshPkg ? 'dsh' : 'dsh-safe', name: p.pkg.name, old: p.pkg.version, target: p.target, pm }))
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
  const opts = { to: undefined, yes: false, restore: true, pm: undefined, selfOnly: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-y' || a === '--yes') opts.yes = true
    else if (a === '--no-restore') opts.restore = false
    else if (a === '--self') opts.selfOnly = true
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
  const opts = { to: undefined, yes: false, restore: true, pm: undefined, selfOnly: false }
  let i = 0
  for (; i < args.length; i++) {
    const a = args[i]
    if (a === '-y' || a === '--yes') opts.yes = true
    else if (a === '--no-restore') opts.restore = false
    else if (a === '--self') opts.selfOnly = true
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
 * 时间戳缓存于 $DSH_HOME/dsh-safe/update-check.json；任何失败都完全静默。
 */
export function maybeNotifySelfUpdate() {
  try {
    if (process.env.DSH_SAFE_NO_UPDATE_CHECK === '1') return
    const selfPkg = resolveSelfPackage()
    if (!selfPkg) return
    const file = updateCheckFile()
    const last = readJsonIfExists(file)
    if (last?.lastCheckAt && Date.now() - Date.parse(last.lastCheckAt) < 24 * 60 * 60 * 1000) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify({ lastCheckAt: new Date().toISOString() }, null, 2)}\n`)
    } catch {}
    const latest = fetchLatestVersion(selfPkg.name)
    if (latest && isNewerVersion(latest, selfPkg.version)) {
      err(t('updateNotify', { new: latest, old: selfPkg.version }))
      err(t('updateNotifyHow', { name: selfPkg.name }))
    }
  } catch {}
}
