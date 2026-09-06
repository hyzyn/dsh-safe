/**
 * @hyzyn/dsh-safe — AI 能力（可选，零依赖，Node 20 全局 fetch）。
 *
 * 走 OpenAI 兼容的 chat completions 接口，默认指向 DeepSeek：
 *   DSH_SAFE_AI_KEY        API key（未设置 = AI 能力整体禁用）
 *   DSH_SAFE_AI_BASE_URL   默认 https://api.deepseek.com
 *   DSH_SAFE_AI_MODEL      默认 deepseek-chat
 *
 * 原则：任何失败（无 key / 网络 / 超时 / 响应异常）都静默返回 null，绝不
 * 影响主流程；模型只是"多一个识别器/解释器"，不获得任何写权限——兜底识别
 * 的输出必须由调用方经 matchFailures 对照真实 patch 行后才生效。
 * 发送前脱敏：用户 home 目录路径替换为 ~。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dshHome, resolveDshSpawnTarget } from './dshpaths.js'
import { loadLedger } from './quarantine.js'
import { getLocale, t } from './i18n.js'

export const aiEnabled = () => Boolean(process.env.DSH_SAFE_AI_KEY)

/** 发送前脱敏：home 绝对路径 → ~。 */
export function redact(text) {
  return String(text ?? '').split(homedir()).join('~')
}

/** OpenAI 兼容 chat completions；任何失败返回 null。 */
async function chat(messages, { timeoutMs = 30_000 } = {}) {
  const key = process.env.DSH_SAFE_AI_KEY
  if (!key) return null
  const base = (process.env.DSH_SAFE_AI_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  const model = process.env.DSH_SAFE_AI_MODEL ?? 'deepseek-chat'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, temperature: 0, stream: false }),
      signal: controller.signal,
    })
    if (!res.ok) return null
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    return typeof content === 'string' && content.trim() ? content.trim() : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 解释一段启动失败的 stderr：失败原因 + 可疑插件 + 修复建议（纯文本）。
 * @param {string} stderr
 * @returns {Promise<string | null>}
 */
export async function explainFailure(stderr) {
  const zh = getLocale() === 'zh'
  const prompt = [
    zh
      ? '以下是一段 dsh（DeepSeek Harness）启动失败时捕获的 stderr。请用中文回答，控制在 200 字内：'
      : 'The following stderr was captured from a failed dsh (DeepSeek Harness) boot. Answer in English, within 200 words:',
    `1) ${zh ? '一句话说明最可能的失败原因；' : 'One sentence on the most likely cause;'}`,
    `2) ${zh ? '指出可疑的插件包名或配置项；' : 'Point out the suspicious plugin package or config;'}`,
    `3) ${zh ? '给出 1-3 条具体修复建议（命令或配置修改）。不要编造不存在的插件。' : 'Give 1-3 concrete fixes (commands or config changes). Do not invent plugins that are not present.'}`,
    '',
    '--- stderr ---',
    redact(stderr),
  ].join('\n')
  return chat([{ role: 'user', content: prompt }])
}

/**
 * AI 兜底识别：正则特征匹配不到坏插件时，让模型从 stderr 里挑出元凶。
 * 只允许在 knownRows（行 id ↔ 包名对照）里选择，降低幻觉；返回结构化
 * 候选 [{ packageName?, entryId?, reason? }]，由调用方经 matchFailures
 * 对照真实行后才生效。
 * @param {string} stderr
 * @param {Array<{ id: string, name: string | null }>} knownRows
 * @returns {Promise<Array<{ packageName?: string, entryId?: string, reason?: string }> | null>}
 *          null = AI 不可用或调用失败（调用方照旧透传）
 */
export async function detectFailureWithAI(stderr, knownRows) {
  const choices = knownRows.filter((r) => r.name || r.id).map((r) => ({ id: r.id, name: r.name ?? undefined }))
  if (!choices.length) return []
  const prompt = [
    'The following stderr is from a failed dsh (DeepSeek Harness) boot. Regex signatures failed to identify the broken plugin.',
    'From the allowed list below, pick the plugin row(s) most likely responsible. Reply with ONLY a JSON array like [{"packageName":"@scope/name","entryId":"row-id","reason":"short why"}]. Use values from the allowed list verbatim; return [] if none plausibly match.',
    'Allowed rows (id ↔ name):',
    JSON.stringify(choices),
    '',
    '--- stderr ---',
    redact(stderr),
  ].join('\n')
  const content = await chat([{ role: 'user', content: prompt }])
  if (!content) return null
  const m = /\[[\s\S]*\]/.exec(content)
  if (!m) return []
  try {
    const arr = JSON.parse(m[0])
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (x) => x && typeof x === 'object' && (typeof x.packageName === 'string' || typeof x.entryId === 'string'),
    )
  } catch {
    return []
  }
}

/** 解读被隔离插件记录（单条或多条）：失败原因分析 + 现在该怎么办的建议。 */
async function interpretLedgerEntries(entries) {
  const zh = getLocale() === 'zh'
  const rows = entries.map(
    (e) => `- id: ${e.id}  ${zh ? '包名' : 'package'}: ${e.name ?? '-'}  ${zh ? '隔离于' : 'quarantined at'}: ${e.quarantinedAt ?? '-'}  ${zh ? '原因' : 'reason'}: ${redact(e.reason ?? '-')}`,
  )
  const prompt = [
    zh
      ? '以下是 dsh-safe（DeepSeek Harness 的启动保险丝）自动隔离的插件记录：启动失败时对应 patch 行被自动禁用。请用中文回答，控制在 200 字内：'
      : 'The following plugins were auto-quarantined by dsh-safe (a startup fuse for DeepSeek Harness): their patch rows were auto-disabled after boot failures. Answer in English, within 200 words:',
    `1) ${zh ? '逐条说明当时最可能的失败原因（模块解析失败 / 配置或代码错误 / 依赖等待）；' : 'Per record, the most likely cause of failure (module resolution / config or code error / dependency wait);'}`,
    `2) ${zh ? '给出当前建议：用 dsh-safe repair <id> 重装修复、升级 dsh 后重试、还是保持禁用。不要编造记录里没有的信息。' : 'Advise what to do now: dsh-safe repair <id> reinstall, retry after an upgrade, or keep disabled. Do not invent facts beyond the records.'}`,
    '',
    zh ? '--- 隔离记录 ---' : '--- quarantine records ---',
    ...rows,
  ].join('\n')
  return chat([{ role: 'user', content: prompt }])
}

/** $DSH_HOME/dsh-safe/ 下最近修改的 last-failure-*.log。 */
function findLatestFailureFile() {
  const dir = join(dshHome(), 'dsh-safe')
  let best
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('last-failure-') || !name.endsWith('.log')) continue
      const path = join(dir, name)
      const mtime = statSync(path).mtimeMs
      if (!best || mtime > best.mtime) best = { path, mtime }
    }
  } catch {}
  return best
}

/**
 * `dsh-safe explain [id]`：AI 解读 dsh-safe 所知的失败信息。
 *   - 指定 <id>：解读该条隔离记录（台账 reason + 上下文，给出 repair 建议）；
 *   - 默认（无 id）：优先解读最近一次启动失败（last-failure-*.log），
 *     没有日志时解读隔离台账；--profile/--file/stdin 另见参数。
 * 纯只读——不碰 patch/台账。
 * @param {string[]} args
 * @param {{
 *   isTTY?: boolean,
 *   readStdin?: () => string,
 *   log?: (line: string) => void,
 *   write?: (line: string) => void,
 * }} [hooks] 可注入（测试）
 * @returns {Promise<number>} 退出码
 */
export async function cmdExplain(args, {
  isTTY = process.stdin.isTTY,
  readStdin = () => readFileSync(0, 'utf8'),
  log = (line) => process.stderr.write(`${line}\n`),
  write = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  if (args.includes('-h') || args.includes('--help')) {
    write(t('helpText', {}))
    return 0
  }
  let file
  let profile
  let id
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--file') file = args[++i]
    else if (a.startsWith('--file=')) file = a.slice('--file='.length)
    else if (a === '--profile') profile = args[++i]
    else if (a.startsWith('--profile=')) profile = a.slice('--profile='.length)
    else if (!a.startsWith('-') && id === undefined) id = a
    else {
      // 严格解析：未知旗标/多余位置参数绝不静默吞
      log(t('explainUnknownArg', { arg: a }))
      return 2
    }
  }
  if (!aiEnabled()) {
    log(t('aiDisabled'))
    return 1
  }

  // ① 指定隔离记录：解读台账条目（给出 repair 建议）
  if (id !== undefined) {
    const matches = []
    for (const [p, entries] of Object.entries(loadLedger().profiles)) {
      if (profile && p !== profile) continue
      for (const entry of entries ?? []) {
        if (entry.id === id) matches.push({ profile: p, entry })
      }
    }
    if (!matches.length) {
      log(t('repairEntryMissing', { id }))
      return 1
    }
    if (matches.length > 1) {
      log(t('repairAmbiguous', { id, profiles: matches.map((m) => m.profile).join(', ') }))
      return 2
    }
    log(t('explainEntry', { id, profile: matches[0].profile }))
    const answer = await interpretLedgerEntries([matches[0].entry])
    if (!answer) {
      log(t('aiExplainFailed'))
      return 1
    }
    write(answer)
    return 0
  }

  // ② 指定日志文件
  if (file !== undefined) {
    let input
    try {
      input = readFileSync(file, 'utf8')
    } catch {
      log(t('aiFileUnreadable', { file }))
      return 2
    }
    if (!input.trim()) {
      log(t('aiNoInput'))
      return 2
    }
    const answer = await explainFailure(input)
    if (!answer) {
      log(t('aiExplainFailed'))
      return 1
    }
    write(answer)
    return 0
  }

  // ③ 管道输入
  if (!isTTY) {
    const input = readStdin()
    if (!input.trim()) {
      log(t('aiNoInput'))
      return 2
    }
    const answer = await explainFailure(input)
    if (!answer) {
      log(t('aiExplainFailed'))
      return 1
    }
    write(answer)
    return 0
  }

  // ④ 默认（交互终端）：最近一次失败日志 → 隔离台账
  const latest = findLatestFailureFile()
  if (latest) {
    log(t('explainUsingLast', { file: latest.path }))
    const input = readFileSync(latest.path, 'utf8')
    if (!input.trim()) {
      log(t('aiNoInput'))
      return 2
    }
    const answer = await explainFailure(input)
    if (!answer) {
      log(t('aiExplainFailed'))
      return 1
    }
    write(answer)
    return 0
  }

  const entries = Object.entries(loadLedger().profiles)
    .filter(([p]) => !profile || p === profile)
    .flatMap(([, list]) => list ?? [])
  if (!entries.length) {
    log(t('explainNoSource'))
    return 2
  }
  log(t('explainLedger', { count: entries.length }))
  const answer = await interpretLedgerEntries(entries)
  if (!answer) {
    log(t('aiExplainFailed'))
    return 1
  }
  write(answer)
  return 0
}
