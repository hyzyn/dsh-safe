/**
 * @hyzyn/dsh-safe — 升级 dsh 后的解析器自校验。
 *
 * 风险背景：报错解析器与 dsh 的 stderr 格式耦合，dsh 升级可能让特征失配，
 * 保险丝静默失效。自校验在临时 DSH_HOME 里搭一次性 profile（引用现场生成
 * 的坏插件），用 PATH 上新装的 dsh 试启——预期启动失败，再确认解析器能从
 * 报错里识别出坏插件。识别失败只告警（附回滚命令），不阻断后续启动。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFailureReport } from './failures.js'
import { matchFailures } from './knownrows.js'
import { resolveDshSpawnTarget } from './dshpaths.js'
import { t } from './i18n.js'

const BAD_ID = 'dsh-safe-verify'
const BAD_NAME = '@dsh-safe-verify/broken'

/**
 * @param {{
 *   rollbackVersion?: string,
 *   log?: (line: string) => void,
 *   timeoutMs?: number,
 *   spawn?: typeof spawnSync,
 * }} [options]
 * @returns {Promise<boolean>} 自校验是否通过
 */
export async function verifyParser({ rollbackVersion, log = (line) => process.stderr.write(`${line}\n`), timeoutMs = 60_000, spawn = spawnSync } = {}) {
  log(t('verifyRunning'))
  const home = mkdtempSync(join(tmpdir(), 'dsh-safe-verify-'))
  try {
    // 一次性 profile：patch 行引用现场生成的坏插件（模块级 throw → import 失败）
    const profileDir = join(home, 'profiles', 'verify')
    const modDir = join(profileDir, 'node_modules', BAD_NAME)
    mkdirSync(join(modDir, 'lib'), { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-verify', private: true }))
    const patchPath = join(profileDir, 'cordis.patch.yml')
    writeFileSync(patchPath, `- id: ${BAD_ID}\n  name: '${BAD_NAME}'\n`)
    writeFileSync(
      join(modDir, 'package.json'),
      JSON.stringify({ name: BAD_NAME, version: '0.0.1', type: 'module', main: 'lib/index.js' }),
    )
    writeFileSync(join(modDir, 'lib', 'index.js'), `throw new Error('dsh-safe parser self-check')\n`)

    const target = resolveDshSpawnTarget('dsh')
    const { status, stderr } = spawn(target.file, [...target.prefix, '--profile', 'verify'], {
      env: { ...process.env, DSH_HOME: home },
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: timeoutMs,
      shell: target.shell,
      encoding: 'utf8',
    })

    if (status === 0) {
      log(t('verifyFailBoot'))
      return false
    }
    if (status === null) {
      // 超时被杀或无法启动试启进程
      log(t('verifyFailTimeout'))
      return false
    }
    const report = parseFailureReport(stderr ?? '')
    const hits = matchFailures(report, {
      rows: [{ id: BAD_ID, name: BAD_NAME, disabled: false, file: patchPath }],
    })
    if (hits.length) {
      log(t('verifyPassed'))
      return true
    }
    log(t('verifyFailNoHit', { version: rollbackVersion ?? '' }))
    return false
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}
