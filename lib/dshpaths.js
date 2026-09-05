/**
 * @hyzyn/dsh-safe — 路径与调用解析。
 *
 * 与 dsh 运行时（@deepseek-ai/dsh-home-paths）保持一致的 home 解析规则：
 * `DSH_HOME` 环境变量优先（支持 `~` 前缀展开），默认 `~/.dsh`。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve, join } from 'node:path'

/** dsh home 目录：`DSH_HOME` 优先，默认 `~/.dsh`。 */
export function dshHome() {
  const raw = process.env.DSH_HOME
  if (!raw || raw.trim() === '') return join(homedir(), '.dsh')
  const expanded = raw === '~' || raw.startsWith('~/')
    ? join(homedir(), raw.slice(1).replace(/^[/\\]/, ''))
    : raw
  return resolve(expanded)
}

export const profileDir = (profile) => join(dshHome(), 'profiles', profile)
export const profilePatchPath = (profile) => join(profileDir(profile), 'cordis.patch.yml')
export const profileManifestPath = (profile) => join(profileDir(profile), 'package.json')

/** dsh home 层的公共 patch（对所有 profile 生效）。 */
export const homePatchPath = () => join(dshHome(), 'cordis.patch.yml')

/** dsh-safe 的隔离台账。 */
export const ledgerFile = () => join(dshHome(), 'dsh-safe', 'quarantine.json')

/** dsh-safe 的更新检查时间戳缓存（每天最多提示一次新版）。 */
export const updateCheckFile = () => join(dshHome(), 'dsh-safe', 'update-check.json')

/** 读文件，不存在或读不了返回 undefined。 */
export const readIfExists = (path) => {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined
  } catch {
    return undefined
  }
}

/**
 * 解析转发给 dsh 的启动参数，识别 profile 与模式。
 *
 * 与 dsh 启动器一致：launcher 自己的旗标在最前（`--profile <v>`、`--patch <v>`
 * 各带一个值），第一个无法识别的位置参数起就是内部参数。因此只在"launcher 前缀"
 * 里找 `--profile`；`plugin` 子命令例外——它的 `--profile` 跟在子命令后面。
 *
 * @param {string[]} args 转发参数（已剥掉 dsh-safe 自己的旗标）
 * @returns {{ mode: 'boot'|'plugin', profile: string|null }}
 */
export function detectInvocation(args) {
  let firstPositional = -1
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('-')) { firstPositional = i; break }
    // 带值的 launcher 旗标：跳过它的值
    if (a === '--profile' || a === '--patch') i++
  }
  const first = firstPositional >= 0 ? args[firstPositional] : undefined
  if (first === 'plugin') {
    let profile
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--profile') profile = args[i + 1]
      else if (args[i].startsWith('--profile=')) profile = args[i].slice('--profile='.length)
    }
    return { mode: 'plugin', profile: profile || null }
  }
  let profile
  const launcherEnd = firstPositional < 0 ? args.length : firstPositional
  for (let i = 0; i < launcherEnd; i++) {
    if (args[i] === '--profile') profile = args[i + 1]
    else if (args[i].startsWith('--profile=')) profile = args[i].slice('--profile='.length)
  }
  if (!profile && first) {
    if (first === 'web') profile = 'web'
    else if (existsSync(profileDir(first))) profile = first
  }
  return { mode: 'boot', profile: profile || null }
}

/**
 * 解析把 dsh 跑起来的 spawn 目标（Windows 兼容的关键）。
 *
 * 非 Windows 的全局 bin 是 symlink / 带执行位脚本，`spawn('dsh')` 原样可用。
 * Windows 的全局 bin 是 .cmd/.ps1 批处理：Node 出于安全禁止无 shell 地 spawn
 * 它们（EINVAL），裸名也不参与 PATHEXT 解析（ENOENT）。因此按 PATH 目录顺序
 * 找 `dsh.exe` / `dsh.cmd` / `dsh.ps1`：
 *   - .exe → 直接 spawn；
 *   - .cmd/.ps1 → 解析 shim 内嵌的 node_modules 入口脚本，改 spawn
 *     `node <entry>`（无 shell、无参数转义问题，stderr 管道行为与 unix 一致）；
 *   - shim 里解析不出入口 → 退回 shell 方式运行 shim 本身；
 *   - PATH 上什么都没有 → 原样返回（报错行为与从前一致）。
 *
 * @param {string} command dsh 可执行名（默认 'dsh'）
 * @param {{
 *   platform?: string,
 *   pathEnv?: string,
 *   execPath?: string,
 *   exists?: (path: string) => boolean,
 *   readFile?: (path: string) => string | undefined,
 * }} [inject] 测试注入
 * @returns {{ file: string, prefix: string[], shell: boolean }}
 *          spawn(file, [...prefix, ...args], { shell })
 */
export function resolveDshSpawnTarget(command, {
  platform = process.platform,
  pathEnv = process.env.PATH ?? '',
  execPath = process.execPath,
  exists = existsSync,
  readFile = (p) => { try { return readFileSync(p, 'utf8') } catch { return undefined } },
} = {}) {
  if (platform !== 'win32') return { file: command, prefix: [], shell: false }
  for (const dir of pathEnv.split(';')) {
    if (!dir) continue
    for (const ext of ['.exe', '.cmd', '.ps1']) { // 同目录内按 PATHEXT 惯例 .exe 优先
      const p = join(dir, command + ext)
      if (!exists(p)) continue
      if (ext === '.exe') return { file: p, prefix: [], shell: false }
      return resolveShimEntry(p, { execPath, exists, readFile })
    }
  }
  return { file: command, prefix: [], shell: false }
}

/** 从 .cmd/.ps1 shim 解析内嵌入口；失败退回 shell 方式运行 shim（路径含空白时加引号）。 */
function resolveShimEntry(shimPath, { execPath, exists, readFile }) {
  const content = readFile(shimPath)
  const entry = content ? findShimEntry(content, dirname(shimPath), exists) : null
  if (entry) return { file: execPath, prefix: [entry], shell: false }
  return { file: /\s/.test(shimPath) ? `"${shimPath}"` : shimPath, prefix: [], shell: true }
}

/**
 * npm/pnpm 的 cmd/ps1 shim 内容里都内嵌 node_modules 下的入口脚本路径：
 * cmd 形如 `"%~dp0\node_modules\@scope\pkg\bin\x.js"`（也可能先 SET 进变量再
 * `node "%_prog%" %*`），ps1 形如 `$basedir/node_modules/...`。%~dp0 与
 * $basedir 都展开为 shim 所在目录；取第一个真实存在的候选。
 */
function findShimEntry(content, shimDir, exists) {
  const candidates = []
  for (const m of content.matchAll(/"([^"\r\n]*node_modules[^"\r\n]*\.(?:js|cjs|mjs))"/gi)) candidates.push(m[1])
  for (const m of content.matchAll(/[\w@.$%~\-\\\/]*node_modules[\w@.$%~\-\\\/]*\.(?:js|cjs|mjs)/gi)) candidates.push(m[0])
  for (let raw of candidates) {
    // `SET "_prog=%~dp0\..."` 会把变量名一起捕进来，切掉 `node_modules` 之前的 `xxx=`
    const eq = raw.indexOf('=')
    if (eq >= 0 && eq < raw.toLowerCase().indexOf('node_modules')) raw = raw.slice(eq + 1)
    const p = resolve(raw.replace(/%~dp0|\$basedir/gi, `${shimDir}/`).replace(/\\/g, '/'))
    if (exists(p)) return p
  }
  return null
}
