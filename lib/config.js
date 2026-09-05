/**
 * @hyzyn/dsh-safe — 用户配置：$DSH_HOME/dsh-safe/config.json（JSON）。
 *
 * 目前只有 exclude（隔离豁免名单：行 id 或插件包名，命中的行永不自动禁用，
 * 适合自己开发中、或明知兼容但偶发报错的插件）。文件损坏时按空配置处理，
 * 绝不影响主流程。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome, readIfExists } from './dshpaths.js'

export const configPath = () => join(dshHome(), 'dsh-safe', 'config.json')

/** @returns {{ exclude: string[] }} */
export function loadConfig() {
  const raw = readIfExists(configPath())
  if (raw === undefined) return { exclude: [] }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.exclude)) {
      return { exclude: parsed.exclude.filter((x) => typeof x === 'string') }
    }
  } catch {}
  return { exclude: [] }
}

export function saveConfig(config) {
  const file = configPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
}
