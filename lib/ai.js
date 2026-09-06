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
  const lang = getLocale() === 'zh' ? '中文' : 'English'
  const prompt = [
    getLocale() === 'zh'
      ? `以下是一段 dsh（DeepSeek Harness）启动失败时捕获的 stderr。请用中文回答，控制在 200 字内：`
      : `The following stderr was captured from a failed dsh (DeepSeek Harness) boot. Answer in English, within 200 words:`,
    `1) ${getLocale() === 'zh' ? '一句话说明最可能的失败原因；' : 'One sentence on the most likely cause;'}`,
    `2) ${getLocale() === 'zh' ? '指出可疑的插件包名或配置项；' : 'Point out the suspicious plugin package or config;'}`,
    `3) ${getLocale() === 'zh' ? '给出 1-3 条具体修复建议（命令或配置修改）。不要编造不存在的插件。' : 'Give 1-3 concrete fixes (commands or config changes). Do not invent plugins that are not present.'}`,
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

/** 试启一个 profile 并捕获 stderr（60s 超时；超时留下的部分 stderr 也可解读）。 */
function bootProfileForExplain(profile, { spawn }) {
  const target = resolveDshSpawnTarget('dsh')
  const { status, stderr } = spawn(target.file, [...target.prefix, '--profile', profile], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: process.env,
    shell: target.shell,
    timeout: 60_000,
    encoding: 'utf8',
  })
  return { code: status ?? 'timeout', stderr: stderr ?? '' }
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
 * `dsh-safe explain`：解读启动失败。输入优先级：
 *   --file <路径> > --profile <名>（现场试启并解读） >
 *   最近一次失败记录（包装启动失败时自动持久化的 last-failure-*.log） >
 *   stdin 管道。纯只读——不碰 patch/台账。
 * @param {string[]} args
 * @param {{
 *   spawn?: typeof spawnSync,
 *   isTTY?: boolean,
 *   readStdin?: () => string,
 *   log?: (line: string) => void,
 *   write?: (line: string) => void,
 * }} [hooks] 可注入（测试）
 * @returns {Promise<number>} 退出码
 */
export async function cmdExplain(args, {
  spawn = spawnSync,
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
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file') file = args[++i]
    else if (args[i].startsWith('--file=')) file = args[i].slice('--file='.length)
    else if (args[i] === '--profile') profile = args[++i]
    else if (args[i].startsWith('--profile=')) profile = args[i].slice('--profile='.length)
  }
  if (!aiEnabled()) {
    log(t('aiDisabled'))
    return 1
  }
  let input = ''
  if (file !== undefined) {
    try {
      input = readFileSync(file, 'utf8')
    } catch {
      log(t('aiFileUnreadable', { file }))
      return 2
    }
  } else if (profile !== undefined) {
    log(t('explainBooting', { profile }))
    const { code, stderr } = bootProfileForExplain(profile, { spawn })
    if (code === 0 || !stderr?.trim()) {
      log(t('explainBootOk', { profile }))
      return 0
    }
    input = stderr
  } else if (!isTTY) {
    input = readStdin()
  } else {
    const latest = findLatestFailureFile()
    if (!latest) {
      log(t('explainNoSource'))
      return 2
    }
    log(t('explainUsingLast', { file: latest.path }))
    input = readFileSync(latest.path, 'utf8')
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
