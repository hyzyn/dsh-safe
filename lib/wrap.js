/**
 * @hyzyn/dsh-safe — 包装运行 dsh 的主循环。
 *
 * 运行 dsh（stderr 进管道并同步回显），进程退出后：
 *   - 正常退出（0）→ 结束；
 *   - 失败退出 → 从 stderr 解析坏插件，对照 patch 行后把对应行置为 disabled
 *     （写入托管区块 + 台账），然后重试；duplicate loader entry id 是禁用行
 *     管不住的硬失败，自动去重冗余来源后重试（去重同样受第一方保护，见
 *     dedupe.js）；识别不出、超过重试上限、或命中第一方插件（@deepseek-ai/*，
 *     默认保护）时原样透传退出码。
 *
 * Windows 上经 resolveDshSpawnTarget 把 dsh 的 .cmd shim 解析成 `node <入口>`
 * 再启动（见 dshpaths.js），其余平台原样 spawn。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { summarizeLine, parseFailureReport, declaredInactiveCount } from './failures.js'
import { collectKnownRows, matchFailures } from './knownrows.js'
import { detectInvocation, lastFailureFile, resolveDshSpawnTarget } from './dshpaths.js'
import { loadLedger, writeQuarantine } from './quarantine.js'
import { dedupeMountSources, isCoreEntry, hasUnknownPackage } from './dedupe.js'
import { loadConfig } from './config.js'
import { aiEnabled, detectFailureWithAI } from './ai.js'
import { t } from './i18n.js'

const CAPTURE_LIMIT = 512 * 1024

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

/** 运行 dsh：stdin/stdout 直通，stderr 回显并捕获（上限内）。onStderr 用于流式巡检。 */
export function spawnDsh(args, { command = 'dsh', onStderr } = {}) {
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
      onStderr?.(captured)
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
  // 宽容启动（dsh ≥ 0.1.6）下的只读巡检。
  //
  // 官方换了启动策略后（app-boot `auditStartupEntries`），非 required 条目失败只打一行
  // `warning: N entries did not activate` 就继续启动：插件静默缺席，而
  // `$DSH_HOME/logs/startup-*.log` 只对致命失败写、这行告警是唯一线索（GUI 启动的用户
  // 连它都看不到）。这里把告警块整理成人能读的清单与修复指引：**不写任何文件、不改
  // patch、不重试**——去重与隔离都只发生在启动失败（非零退出）路径上。
  //
  // 必须在运行中就能报出来：长驻的 `dsh web` 要到退出才报等于没报。stderr 分多个
  // chunk 到达，所以按头部声明的条目数对账，收全即报，报过不重复。
  let inspected = false
  // 启动告警总在最开始的几 KB 里出现：给它有限的解析次数，避免长驻进程持续输出 stderr
  // 时每个 chunk 都做一次全量解析（收不全就由退出路径兜底，那次只解析一次）
  let liveBudget = 20
  const reportInactive = (report) => {
    if (inspected || !report.inactive.length) return
    inspected = true
    log(t('inactiveDetected', { count: report.inactive.length }))
    for (const item of report.inactive) {
      const label = item.name ? `${item.id} (${item.name})` : item.id
      log(t('inactiveLine', { label, reason: summarizeLine(item.detail || item.line) }))
    }
    log(t('inactiveHint'))
  }
  const inspectLive = (text) => {
    if (inspected || liveBudget <= 0 || !invocation.profile || !text) return
    const declared = declaredInactiveCount(text)
    if (declared === null) return
    liveBudget -= 1
    const report = parseFailureReport(text)
    if (report.inactive.length >= declared) reportInactive(report)
  }
  // 退出路径的兜底：注入的 spawn 实现不一定支持流式回调，或块被截断没收全
  const inspectAtExit = (text) => {
    if (inspected || !invocation.profile || !text) return
    if (declaredInactiveCount(text) === null) return
    reportInactive(parseFailureReport(text))
  }
  // 台账非空提醒：让"有插件处于自动禁用状态"在每次启动都可见（否则用户
  // 只会感知到"某个功能没了"，不知道是隔离造成的、也不知道怎么恢复）
  if (!dryRun && invocation.profile) {
    const count = (loadLedger().profiles[invocation.profile] ?? []).length
    if (count) log(t('ledgerReminder', { count }))
  }
  const quarantined = [] // 本次运行期间被自动禁用的插件（成功后汇总）
  for (let attempt = 0; ; attempt++) {
    const { code, stderr } = await spawnFn(forwardArgs, { onStderr: inspectLive })
    if (code === 0) {
      if (quarantined.length) {
        log(
          t('bootQuarantineSummary', {
            count: quarantined.length,
            names: quarantined.map((target) => target.name ?? target.id).join(', '),
          }),
        )
      }
      // 启动成功但有条目未激活（dsh ≥ 0.1.6 的宽容策略）：只读巡检，不写任何文件
      inspectAtExit(stderr)
      return 0
    }
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
    // 自动去重（交互选来源 / 非交互保留先声明者）后重试；识别不出可去重
    // 来源（扫描器盲区）、dry-run 或超过重试上限时给一键修复指引并透传。
    if (stderr.includes('duplicate loader entry id')) {
      const m = /duplicate loader entry id: ([\w:\-]+)/.exec(stderr)
      const dupId = m ? m[1] : ''
      let fixed = null
      if (!dryRun && attempt < maxRetries) {
        const res = await dedupeMountSources(invocation.profile, dupId, {
          tty: process.stdin.isTTY,
          log,
          allowFirstParty,
        })
        if (!('error' in res)) fixed = res
      }
      if (fixed) {
        log(t('repairDedupeDone', { keep: fixed.kept, removed: fixed.removed.join(', ') }))
        log(t('retrying'))
        continue
      }
      if (!dryRun && attempt >= maxRetries) log(t('maxRetriesReached', { count: maxRetries }))
      log(t('repairDuplicate', { id: dupId }))
      log(t('explainHint'))
      return code
    }
    const known = collectKnownRows(invocation.profile)
    const report = parseFailureReport(stderr)
    // 环境类失败（端口被占 / 权限 / 网络）不能归因到插件：元凶在环境，而依赖其服务
    // 的插件只会表现为 "pending (waiting for service: …)"。基于这种 stderr 做的隔离
    // 都是误判，且隔离是持久写入——一律不隔离、不重试，只说明原因交回用户。
    if (report.environmental.length) {
      for (const [label, line] of report.environmental) {
        log(t('envFailure', { label, reason: summarizeLine(line) }))
      }
      log(t('envFailureHint'))
      log(t('explainHint'))
      return code
    }
    let hits = matchFailures(report, known)
    const detectFn = detect ?? (aiRecoverEnabled() ? defaultDetect : null)
    if (!hits.length && detectFn) {
      // detect 返回 AI 候选（picks），一律经 picksToHits 对照真实行后才成为 hits
      const picks = await detectFn(stderr, known, log)
      hits = picksToHits(picks, known, stderr, log)
    }
    const quarantinable = []
    const core = []
    const requiredCore = []
    const unknown = []
    // 豁免名单：config.json 的 exclude + 包装旗标 --exclude（行 id 或包名），永不自动禁用
    const excluded = new Set([...loadConfig().exclude, ...exclude])
    const isExcluded = (hit) => excluded.has(hit.id) || (hit.name != null && excluded.has(hit.name))
    // dsh ≥ 0.1.6 的致命诊断会显式标注 `(required)`：这类条目就是"启动了也等于没启动"
    // 的那几个，禁用它修不好任何问题，任何旗标都不放开（与核心依赖同等强度）
    const requiredIds = new Set(report.required)
    for (const hit of hits) {
      if (hit.disabled) continue // 已经是禁用状态
      if (requiredIds.has(hit.id)) requiredCore.push(hit)
      // 核心依赖优先于一切：不依赖包名解析，也不受任何旗标影响（见 dedupe.js 的说明）
      else if (isCoreEntry(hit, known)) core.push(hit)
      // 包名无法确定 → 不能排除它是核心依赖，同样不隔离（fail closed）
      else if (hasUnknownPackage(hit)) unknown.push(hit)
      else if (isExcluded(hit)) log(t('excludedByList', { label: hit.name ?? hit.id }))
      else quarantinable.push(hit)
    }
    // 提示统一用行 id：它就是 patch 里要手动处理的那一行；包名在 reason 原文里已可见，
    // 而命中行解析出的包名未必可信（例如报错把官方包的包名写成了第三方）。
    for (const hit of requiredCore) {
      log(t('skipRequiredEntry', { id: hit.id, reason: summarizeLine(hit.line) }))
    }
    for (const hit of core) {
      log(t('skipCore', { id: hit.id, reason: summarizeLine(hit.line) }))
    }
    for (const hit of unknown) {
      log(t('skipUnknownPackage', { id: hit.id, reason: summarizeLine(hit.line) }))
    }
    if (!quarantinable.length) {
      if (!core.length && !requiredCore.length && !unknown.length) {
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
    quarantined.push(...targets)
    for (const target of targets) {
      const verb = t(dryRun ? 'willDisable' : 'disabled')
      log(`[dsh-safe] ${verb} ${target.name ?? target.id} (id: ${target.id}) → ${target.file}`)
      log(t('reasonIndent', { reason: target.reason }))
    }
    if (dryRun) return code
    log(t('retrying'))
  }
}
