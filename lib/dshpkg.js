/**
 * @hyzyn/dsh-safe — 定位 dsh / dsh-safe 自身的安装位置与包管理器。
 *
 * PATH 上的可执行文件 realpath → 向上找最近的 package.json，得到包名、版本与包目录；
 * Windows 的全局 bin 是 .cmd/.ps1 拷贝而非 symlink，改为解析 shim 内嵌的入口路径。
 *
 * 单独成模块（而不是留在 update.js）：这里只有路径与包管理器的机械逻辑、不依赖任何
 * 业务模块，而 update（升级）、doctor（体检）、knownrows（找官方 bundle 的行）都要用。
 * 留在 update.js 会形成 knownrows → update → verify → knownrows 的循环依赖。
 */
import { accessSync, constants, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { delimiter, dirname, join } from 'node:path'
import { readIfExists } from './dshpaths.js'

const WIN32 = process.platform === 'win32'

/**
 * 运行包管理器命令并捕获输出（view / pnpm root -g）。
 * Windows 上 npm/pnpm 是 .cmd 批处理，Node 禁止无 shell 地 spawn（EINVAL），
 * 必须走 cmd.exe；传参只含已校验的包名与版本号（--to 有 ^[\w.+-]+$ 校验）。
 */
export function spawnPmCapture(bin, args) {
  return WIN32
    ? spawnSync(bin, args, { encoding: 'utf8', shell: true })
    : spawnSync(bin, args, { encoding: 'utf8' })
}

/** 运行包管理器命令并透传 stdio（install）。Windows 处理同上。 */
export function spawnPmInherit(bin, args) {
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
export function whichCmd(name) {
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

/**
 * dsh 安装目录下的 node_modules（未装 dsh 或解析不到时为空数组）。
 *
 * 官方 bundle（@deepseek-ai/dsh-base、@deepseek-ai/dsh-web-app 等）**不在** profile 的
 * node_modules 里，而是装在这里、由 dsh 用它自己的模块解析加载。只按 profile 目录找会
 * 把这些 bundle 的行整表漏掉（实测：官方行的包名因此解析不到，第一方保护静默失效）。
 *
 * @returns {string[]}
 */
export function dshInstallNodeModules() {
  const pkg = resolveDshPackage()
  return pkg ? [join(pkg.pkgDir, 'node_modules')] : []
}
