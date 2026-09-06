/**
 * @hyzyn/dsh-safe — 包装运行 dsh 的主循环。
 *
 * 运行 dsh（stderr 进管道并同步回显），进程退出后：
 *   - 正常退出（0）→ 结束；
 *   - 失败退出 → 从 stderr 解析坏插件，对照 patch 行后把对应行置为 disabled
 *     （写入托管区块 + 台账），然后重试；识别不出、超过重试上限、或命中
 *     第一方插件（@deepseek-ai/*，默认保护）时原样透传退出码。
 *
 * Windows 上经 resolveDshSpawnTarget 把 dsh 的 .cmd shim 解析成 `node <入口>`
 * 再启动（见 dshpaths.js），其余平台原样 spawn。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { summarizeLine, parseFailureReport } from './failures.js'
import { collectKnownRows, matchFailures } from './knownrows.js'
import { detectInvocation, lastFailureFile, resolveDshSpawnTarget } from './dshpaths.js'
import { writeQuarantine } from './quarantine.js'
import { loadConfig } from './config.js'
import { aiEnabled, detectFailureWithAI } from './ai.js'
import { t } from './i18n.js'

const CAPTURE_LIMIT = 512 * 1024
const FIRST_PARTY_PREFIX = '@deepseek-ai/'

const isFirstParty = (name) => typeof name === 'string' && name.startsWith(FIRST_PARTY_PREFIX)

/** 启动失败时把捕获的 stderr 存到 last-failure-<profile>.log（供 explain 默认解读与人工翻阅）。 */
function persistFailure(profile, stderr) {
  try {
    if (!stderr?.trim()) return
    const file = lastFailureFile(profile)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, stderr)
  } catch {}
}

const aiRecoverEnabled = () => process.env.DSH_SAFE_AI_RECOVER === '1' && aiEnabled()

/**
 * AI 兜底默认实现：让模型从 stderr 里挑元凶，输出被转换成一份"报告"再走
 * matchFailures——与正则识别完全相同的对照管线（真实行校验、第一方保护、
 * disabled 跳过），命中不了就照旧透传，模型没有任何写权限。
 */
function picksToHits(picks, known, stderr, log) {
  if (!picks?.length) return []
  const fallbackReason = summarizeLine(stderr)
  const names = picks.filter((p) => p.packageName).map((p) => [p.packageName, p.reason ?? fallbackReason])
  const entryIds = picks.filter((p) => p.entryId).map((p) => [p.entryId, p.reason ?? fallbackReason])
  const hits = matchFailures({ names, entryIds }, known)
  if (hits.length) log(t('aiRecovered', { count: hits.length }))
  return hits
}

const defaultDetect = (stderr, known) =>
  detectFailureWithAI(stderr, known.rows.map(({ id, name }) => ({ id, name })))

/** shell 方式兜底时给含空白的参数补引号（正常路径不走 shell，不受影响）。 */
const quoteShellArg = (a) => (/\s/.test(a) && !/^".*"$/.test(a) ? `"${a}"` : a)

/** 运行 dsh：stdin/stdout 直通，stderr 回显并捕获（上限内）。 */
export function spawnDsh(args, { command = 'dsh' } = {}) {
  const target = resolveDshSpawnTarget(command)
  return new Promise((resolve) => {
    const child = spawn(target.file, [...target.prefix, ...(target.shell ? args.map(quoteShellArg) : args)], {
      stdio: ['inherit', 'inherit', 'pipe'],
      env: process.env,
      shell: target.shell,
    })
    let captured = ''
    child.stderr?.on('data', (chunk) => {
      process.stderr.write(chunk)
      if (captured.length < CAPTURE_LIMIT) captured += chunk
    })
    child.on('error', (error) => {
      process.stderr.write(`${t('spawnFailed', { command, message: error.message })}\n`)
      resolve({ code: 127, stderr: captured })
    })
    child.on('close', (code) => resolve({ code: code ?? 1, stderr: captured }))
  })
}

/**
 * @param {{
 *   forwardArgs: string[],
 *   dryRun?: boolean,
 *   maxRetries?: number,
 *   allowFirstParty?: boolean,
 *   log?: (...args: any[]) => void,
 *   spawn?: typeof spawnDsh,
 *   detect?: (stderr: string, known: object, log: (line: string) => void) => Promise<Array<{ packageName?: string, entryId?: string, reason?: string }>>,
 * }} options
 * @returns {Promise<number>} 最终退出码
 */
export async function runWrapped(options) {
  const {
    forwardArgs,
    dryRun = false,
    maxRetries = 2,
    allowFirstParty = false,
    exclude = [],
    log = (line) => process.stderr.write(`${line}\n`),
    spawn: spawnFn = spawnDsh,
    detect = null,
  } = options
  const invocation = detectInvocation(forwardArgs)
  for (let attempt = 0; ; attempt++) {
    const { code, stderr } = await spawnFn(forwardArgs)
    if (code === 0) return 0
    if (invocation.mode === 'plugin') {
      log(t('pluginPassthrough'))
      return code
    }
    if (!invocation.profile) {
      log(t('noProfile'))
      return code
    }
    if (!dryRun) persistFailure(invocation.profile, stderr)
    // 重复挂载（同一 id 被多个 bundle/行挂载）发生在 include 挂载阶段，
    // 早于 profile 层 disabled 覆盖的合并——禁用行管不住它，隔离无效。
    // 给出一键修复指引（repair 会移除冗余来源并恢复）并透传。
    if (stderr.includes('duplicate loader entry id')) {
      const m = /duplicate loader entry id: ([\w:\-]+)/.exec(stderr)
      log(t('repairDuplicate', { id: m ? m[1] : '' }))
      log(t('explainHint'))
      return code
    }
    const known = collectKnownRows(invocation.profile)
    const report = parseFailureReport(stderr)
    let hits = matchFailures(report, known)
    const detectFn = detect ?? (aiRecoverEnabled() ? defaultDetect : null)
    if (!hits.length && detectFn) {
      // detect 返回 AI 候选（picks），一律经 picksToHits 对照真实行后才成为 hits
      const picks = await detectFn(stderr, known, log)
      hits = picksToHits(picks, known, stderr, log)
    }
    const quarantinable = []
    const firstParty = []
    // 豁免名单：config.json 的 exclude + 包装旗标 --exclude（行 id 或包名），永不自动禁用
    const excluded = new Set([...loadConfig().exclude, ...exclude])
    const isExcluded = (hit) => excluded.has(hit.id) || (hit.name != null && excluded.has(hit.name))
    for (const hit of hits) {
      if (hit.disabled) continue // 已经是禁用状态
      if (isFirstParty(hit.name) && !allowFirstParty) firstParty.push(hit)
      else if (isExcluded(hit)) log(t('excludedByList', { label: hit.name ?? hit.id }))
      else quarantinable.push(hit)
    }
    for (const hit of firstParty) {
      log(t('skipFirstParty', { name: hit.name, id: hit.id }))
    }
    if (!quarantinable.length) {
      if (!firstParty.length) {
        log(t('nothingFound'))
        log(t('explainHint'))
      }
      return code
    }
    if (attempt >= maxRetries) {
      log(t('maxRetriesReached', { count: maxRetries }))
      return code
    }
    const targets = quarantinable.map((hit) => ({
      id: hit.id,
      name: hit.name,
      reason: summarizeLine(hit.line),
      file: hit.file,
    }))
    writeQuarantine(invocation.profile, targets, dryRun)
    for (const target of targets) {
      const verb = t(dryRun ? 'willDisable' : 'disabled')
      log(`[dsh-safe] ${verb} ${target.name ?? target.id} (id: ${target.id}) → ${target.file}`)
      log(t('reasonIndent', { reason: target.reason }))
    }
    if (dryRun) return code
    log(t('retrying'))
  }
}
