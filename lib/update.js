/**
 * @hyzyn/dsh-safe — `dsh-safe update`：升级 dsh 并自动恢复被隔离的插件。
 *
 * 自动探测：PATH 上的 dsh 可执行文件 realpath → 向上找最近的 package.json
 * 得到包名与当前版本；包管理器按 realpath 是否落在 pnpm 全局根下判定
 * （PATH 上有 pnpm 时探测，否则默认 npm），--pm 可强制指定。
 * 升级完成后遍历台账恢复全部被隔离的插件（新 dsh 下仍不兼容的会在
 * 下次启动时再次被自动隔离），并提示回滚方式。
 */
import { accessSync, constants, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { delimiter, dirname, join } from 'node:path'
import { loadLedger, restoreQuarantine } from './quarantine.js'
import { readIfExists } from './dshpaths.js'
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

/** 在 PATH 上找可执行文件，返回绝对路径或 null。 */
function whichCmd(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  return null
}

/**
 * 解析 PATH 上的 dsh：realpath 后向上找最近的 package.json。
 * @returns {{ name: string, version: string, pkgDir: string } | null}
 */
export function resolveDshPackage() {
  const bin = whichCmd('dsh')
  if (!bin) return null
  let real
  try {
    real = realpathSync(bin)
  } catch {
    return null
  }
  let dir = dirname(real)
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

/** 判断 dsh 的安装方式：落在 pnpm 全局根下则为 pnpm，否则 npm。 */
export function detectPm(pkgDir) {
  const pnpmBin = whichCmd('pnpm')
  if (!pnpmBin) return 'npm'
  const { status, stdout } = spawnSync(pnpmBin, ['root', '-g'], { encoding: 'utf8' })
  const root = status === 0 ? (stdout ?? '').trim() : ''
  if (root && (pkgDir === root || pkgDir.startsWith(`${root}/`) || pkgDir.startsWith(`${root}\\`))) return 'pnpm'
  return 'npm'
}

/** npm view 查最新版本，失败返回 null。 */
function fetchLatestVersion(pm, name) {
  const bin = whichCmd(pm)
  const { status, stdout } = spawnSync(bin ?? pm, ['view', name, 'version'], { encoding: 'utf8' })
  const version = status === 0 ? (stdout ?? '').trim() : ''
  return /^[\w.+-]+$/.test(version) ? version : null
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
 * @param {{ to?: string, yes?: boolean, restore?: boolean, pm?: string }} opts
 * @param {string[] | null} bootArgs
 * @param {{ boot?: (args: string[]) => Promise<number> }} hooks
 */
async function updateAndMaybeBoot(opts, bootArgs, { boot } = {}) {
  const pkg = resolveDshPackage()
  if (!pkg) {
    err(t('updateDshNotFound'))
    return 1
  }
  const pm = opts.pm ?? detectPm(pkg.pkgDir)

  let latest = null
  if (!opts.to) {
    latest = fetchLatestVersion(pm, pkg.name)
    if (!latest) {
      if (bootArgs) {
        err(t('updateSkipCheckWarn', { pm }))
        return boot(bootArgs)
      }
      err(t('updateLatestFetchFail', { name: pkg.name, pm }))
      return 1
    }
  }
  const target = opts.to ?? latest
  if (target === pkg.version) {
    if (bootArgs) return boot(bootArgs)
    err(t('updateAlreadyLatest', { version: pkg.version }))
    return 0
  }

  const installCmd = pm === 'pnpm' ? 'pnpm' : 'npm'
  const installArgs =
    pm === 'pnpm' ? ['add', '-g', `${pkg.name}@${target}`] : ['install', '-g', `${pkg.name}@${target}`]
  err(t('updatePlan', { name: pkg.name, old: pkg.version, target, pm }))
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
  const { status } = spawnSync(whichCmd(installCmd) ?? installCmd, installArgs, { stdio: 'inherit' })
  if (status !== 0) {
    err(t('updateInstallFail', { code: status ?? '?' }))
    return status ?? 1
  }

  const fresh = resolveDshPackage()
  const newVersion = fresh?.version
  if (!newVersion) err(t('updateVerifyWarn'))
  else err(t('updateDone', { old: pkg.version, new: newVersion }))

  if (opts.restore) {
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
  } else {
    err(t('updateRestoreSkipped'))
  }
  if (newVersion && newVersion !== pkg.version) err(t('updateRollbackHint', { version: pkg.version }))
  if (bootArgs) return boot(bootArgs)
  return 0
}

/** 解析 update 子命令参数；出错返回 { error: { key, params? } } 供 i18n。 */
function parseUpdateArgs(args) {
  const opts = { to: undefined, yes: false, restore: true, pm: undefined }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-y' || a === '--yes') opts.yes = true
    else if (a === '--no-restore') opts.restore = false
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
  return { opts }
}

/**
 * `-u` 模式的前缀解析：从头吃掉 update 选项，第一个不认识的参数起就是
 * dsh 启动参数（宽松处理——不像子命令那样对未知参数报错）。
 */
function parseLeadingUpdateArgs(args) {
  const opts = { to: undefined, yes: false, restore: true, pm: undefined }
  let i = 0
  for (; i < args.length; i++) {
    const a = args[i]
    if (a === '-y' || a === '--yes') opts.yes = true
    else if (a === '--no-restore') opts.restore = false
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
  return { opts, rest }
}
