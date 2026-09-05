/**
 * @hyzyn/dsh-safe — 包装运行 dsh 的主循环。
 *
 * 运行 dsh（stderr 进管道并同步回显），进程退出后：
 *   - 正常退出（0）→ 结束；
 *   - 失败退出 → 从 stderr 解析坏插件，对照 patch 行后把对应行置为 disabled
 *     （写入托管区块 + 台账），然后重试；识别不出、超过重试上限、或命中
 *     第一方插件（@deepseek-ai/*，默认保护）时原样透传退出码。
 */
import { spawn } from 'node:child_process'
import { summarizeLine, parseFailureReport } from './failures.js'
import { collectKnownRows, matchFailures } from './knownrows.js'
import { detectInvocation } from './dshpaths.js'
import { writeQuarantine } from './quarantine.js'

const CAPTURE_LIMIT = 512 * 1024
const FIRST_PARTY_PREFIX = '@deepseek-ai/'

const isFirstParty = (name) => typeof name === 'string' && name.startsWith(FIRST_PARTY_PREFIX)

/** 运行 dsh：stdin/stdout 直通，stderr 回显并捕获（上限内）。 */
export function spawnDsh(args, { command = 'dsh' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['inherit', 'inherit', 'pipe'],
      env: process.env,
    })
    let captured = ''
    child.stderr?.on('data', (chunk) => {
      process.stderr.write(chunk)
      if (captured.length < CAPTURE_LIMIT) captured += chunk
    })
    child.on('error', (error) => {
      process.stderr.write(`[dsh-safe] 无法启动 ${command}: ${error.message}\n`)
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
 * }} options
 * @returns {Promise<number>} 最终退出码
 */
export async function runWrapped(options) {
  const {
    forwardArgs,
    dryRun = false,
    maxRetries = 2,
    allowFirstParty = false,
    log = (line) => process.stderr.write(`${line}\n`),
    spawn: spawnFn = spawnDsh,
  } = options
  const invocation = detectInvocation(forwardArgs)
  for (let attempt = 0; ; attempt++) {
    const { code, stderr } = await spawnFn(forwardArgs)
    if (code === 0) return 0
    if (invocation.mode === 'plugin') {
      log('[dsh-safe] `dsh plugin` 为 pnpm 转发，不做隔离，原样透传。')
      return code
    }
    if (!invocation.profile) {
      log('[dsh-safe] 未能从参数确定 profile（launcher 旗标需在最前，或用 --profile <name>），无法自动隔离，原样透传。')
      return code
    }
    const known = collectKnownRows(invocation.profile)
    const report = parseFailureReport(stderr)
    const hits = matchFailures(report, known)
    const quarantinable = []
    const firstParty = []
    for (const hit of hits) {
      if (hit.disabled) continue // 已经是禁用状态
      if (isFirstParty(hit.name) && !allowFirstParty) firstParty.push(hit)
      else quarantinable.push(hit)
    }
    for (const hit of firstParty) {
      log(`[dsh-safe] 跳过第一方插件 ${hit.name} (id: ${hit.id}) —— 默认保护 @deepseek-ai/*，需要手动处理；确认要禁用可加 --allow-first-party。`)
    }
    if (!quarantinable.length) {
      if (!firstParty.length) log('[dsh-safe] 报错里没有识别出可自动隔离的已挂载插件，原样透传。')
      return code
    }
    if (attempt >= maxRetries) {
      log(`[dsh-safe] 已达最大重试次数（--max-retries ${maxRetries}），不再重试。`)
      return code
    }
    const targets = quarantinable.map((hit) => ({
      id: hit.id,
      name: hit.name,
      reason: summarizeLine(hit.line),
      file: hit.file,
    }))
    writeQuarantine(invocation.profile, targets, dryRun)
    for (const t of targets) {
      const verb = dryRun ? '（dry-run）将禁用' : '已禁用'
      log(`[dsh-safe] ${verb} ${t.name ?? t.id} (id: ${t.id}) → ${t.file}`)
      log(`           原因: ${t.reason}`)
    }
    if (dryRun) return code
    log('[dsh-safe] 重试启动…')
  }
}
