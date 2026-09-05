/**
 * @hyzyn/dsh-safe — 路径与调用解析。
 *
 * 与 dsh 运行时（@deepseek-ai/dsh-home-paths）保持一致的 home 解析规则：
 * `DSH_HOME` 环境变量优先（支持 `~` 前缀展开），默认 `~/.dsh`。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'

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
