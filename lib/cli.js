/**
 * @hyzyn/dsh-safe — 命令行入口。
 *
 * 用法：
 *   dsh-safe <dsh 参数…>        包装运行 dsh（dsh-safe 的旗标必须写在最前）
 *   dsh-safe list [--profile <名>]
 *   dsh-safe restore --profile <名> (--id <id>… | --all) [--dry-run]
 *   dsh-safe help | --version
 */
import { createRequire } from 'node:module'
import { loadLedger, restoreQuarantine } from './quarantine.js'
import { runWrapped } from './wrap.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')

const HELP = `dsh-safe ${version} — dsh 启动保险丝

社区插件与 dsh 运行时不兼容会让 dsh 整体启动失败。dsh-safe 包装运行 dsh：
启动失败时从报错里识别坏插件，在 profile patch 里把对应行置为 disabled
（记录进隔离台账），然后自动重试。

用法:
  dsh-safe <dsh 参数…>             包装运行 dsh，例: dsh-safe web
  dsh-safe list [--profile <名>]    查看隔离名单（缺省列出全部 profile）
  dsh-safe restore --profile <名> (--id <id> | --all) [--dry-run]
                                    恢复被自动禁用的插件（升级修复后使用）
  dsh-safe help                     显示本帮助
  dsh-safe --version                显示版本

包装模式选项（必须写在 profile / 子命令之前）:
  --dry-run                只解析与报告，不修改任何文件
  --max-retries <n>        自动隔离后最多重试启动的次数（默认 2）
  --allow-first-party      允许自动禁用 @deepseek-ai/* 第一方插件（默认跳过）

说明:
  - 行的禁用以 patch 文件末尾的托管区块写入（带标记注释），不改动用户内容；
    恢复用 dsh-safe restore，或手动删除区块。
  - 只隔离"启动期"失败（模块解析失败 / apply 抛错 / 等不到注入服务）；
    运行期的未捕获异常仍由 dsh 自身的 fail-loud 策略处理。
`

function printHelp() {
  process.stdout.write(HELP)
}

function printVersion() {
  process.stdout.write(`${version}\n`)
}

/** 解析 `--profile <名>` / `--profile=<名>`，返回 [值, 剩余参数]。 */
function takeProfile(args) {
  let profile
  const rest = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--profile') {
      profile = args[++i]
    } else if (args[i].startsWith('--profile=')) {
      profile = args[i].slice('--profile='.length)
    } else {
      rest.push(args[i])
    }
  }
  return [profile, rest]
}

/** 解析可重复的 `--id <id>` / `--id=<id>`。 */
function takeIds(args) {
  const ids = []
  const rest = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--id') {
      const v = args[++i]
      if (v !== undefined) ids.push(v)
    } else if (args[i].startsWith('--id=')) {
      ids.push(args[i].slice('--id='.length))
    } else {
      rest.push(args[i])
    }
  }
  return [ids, rest]
}

function cmdList(args) {
  const [profile] = takeProfile(args)
  const ledger = loadLedger()
  const profiles = profile ? [profile] : Object.keys(ledger.profiles).sort()
  let found = 0
  for (const p of profiles) {
    const entries = ledger.profiles[p] ?? []
    if (!entries.length) continue
    process.stdout.write(`${p}:\n`)
    for (const e of entries) {
      found++
      process.stdout.write(`  - ${e.name ?? '(未知包名)'} (id: ${e.id})\n      隔离于 ${e.quarantinedAt}\n      原因: ${e.reason}\n      位置: ${e.file}\n`)
    }
  }
  if (!found) process.stdout.write(profile ? `${profile}: 没有隔离记录\n` : '没有隔离记录\n')
  return 0
}

function cmdRestore(args) {
  const [profile0, rest0] = takeProfile(args)
  const [ids0, rest1] = takeIds(rest0)
  const dryRun = rest1.includes('--dry-run')
  const all = rest1.includes('--all')
  const profile = profile0
  if (!profile) {
    process.stderr.write('[dsh-safe] restore 需要 --profile <名>\n')
    return 2
  }
  if (!all && ids0.length === 0) {
    process.stderr.write('[dsh-safe] restore 需要 --id <id>（可重复）或 --all\n')
    return 2
  }
  const { restored, kept } = restoreQuarantine(profile, all ? 'all' : ids0, dryRun)
  const verb = dryRun ? '（dry-run）将恢复' : '已恢复'
  for (const e of restored) process.stdout.write(`[dsh-safe] ${verb} ${e.name ?? e.id} (id: ${e.id})\n`)
  if (!restored.length) process.stdout.write('[dsh-safe] 没有匹配的隔离记录\n')
  else if (kept.length) process.stdout.write(`[dsh-safe] ${profile} 仍隔离 ${kept.length} 行；重启 dsh 生效。\n`)
  else process.stdout.write('[dsh-safe] 该 profile 的隔离名单已清空；重启 dsh 生效。\n')
  return 0
}

/**
 * @param {string[]} argv process.argv.slice(2)
 * @returns {Promise<number>} 退出码
 */
export async function main(argv) {
  if (argv.length === 0) {
    printHelp()
    return 0
  }
  const [cmd] = argv
  if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
    printHelp()
    return 0
  }
  if (cmd === '--version' || cmd === '-V' || cmd === 'version') {
    printVersion()
    return 0
  }
  if (cmd === 'list') return cmdList(argv.slice(1))
  if (cmd === 'restore') return cmdRestore(argv.slice(1))

  // 包装模式：剥掉 dsh-safe 自己的旗标（必须出现在第一个位置参数之前），
  // 其余原样转发给 dsh。
  const forwardArgs = []
  let dryRun = false
  let maxRetries = 2
  let allowFirstParty = false
  let i = 0
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') { dryRun = true; continue }
    if (a === '--allow-first-party') { allowFirstParty = true; continue }
    if (a === '--max-retries') {
      const raw = argv[++i]
      const v = raw === undefined || raw === '' ? NaN : Number(raw)
      if (!Number.isFinite(v) || v < 0) {
        process.stderr.write('[dsh-safe] --max-retries 需要一个非负整数\n')
        return 2
      }
      maxRetries = v
      continue
    }
    if (a.startsWith('--max-retries=')) {
      const raw = a.slice('--max-retries='.length)
      const v = raw === '' ? NaN : Number(raw)
      if (!Number.isFinite(v) || v < 0) {
        process.stderr.write('[dsh-safe] --max-retries 需要一个非负整数\n')
        return 2
      }
      maxRetries = v
      continue
    }
    break
  }
  forwardArgs.push(...argv.slice(i))
  if (!forwardArgs.length) {
    printHelp()
    return 0
  }
  if (dryRun) process.stderr.write('[dsh-safe] dry-run：只报告，不修改文件。\n')
  return runWrapped({ forwardArgs, dryRun, maxRetries, allowFirstParty })
}
