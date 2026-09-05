/**
 * @hyzyn/dsh-safe — 输出语言自适应。
 *
 * 语言判定优先级：DSH_SAFE_LANG > LC_ALL > LC_MESSAGES > LANG > LANGUAGE。
 * 值为 zh* 时用中文，否则英文；全部未设置（或为 C/POSIX）时退回 Node 的
 * Intl 默认 locale，仍非 zh 则英文。零依赖，不引 i18n 库。
 */

const ZH = {
  // ---- cli.js ----
  helpText: `dsh-safe {version} — dsh 启动保险丝

社区插件与 dsh 运行时不兼容会让 dsh 整体启动失败。dsh-safe 包装运行 dsh：
启动失败时从报错里识别坏插件，在 profile patch 里把对应行置为 disabled
（记录进隔离台账），然后自动重试。

用法:
  dsh-safe <dsh 参数…>             包装运行 dsh，例: dsh-safe web
  dsh-safe -u [<dsh 参数…>]         先升级 dsh（已最新则跳过），再启动
  dsh-safe list [--profile <名>]    查看隔离名单（缺省列出全部 profile）
  dsh-safe restore --profile <名> (--id <id> | --all) [--dry-run]
                                    恢复被自动禁用的插件（升级修复后使用）
  dsh-safe update [-y] [--to <版本>] [--no-restore] [--pm npm|pnpm]
                                    升级 dsh，并自动恢复被隔离的插件
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
  - 输出语言跟随 LC_ALL / LC_MESSAGES / LANG / LANGUAGE（zh* 中文，其余英文）；
    可用环境变量 DSH_SAFE_LANG=zh|en 强制指定。
`,
  unknownName: '(未知包名)',
  quarantinedAt: '      隔离于 {time}',
  reasonLine: '      原因: {reason}',
  locationLine: '      位置: {file}',
  noRecordsProfile: '{profile}: 没有隔离记录',
  noRecords: '没有隔离记录',
  restoreNeedsProfile: '[dsh-safe] restore 需要 --profile <名>',
  restoreNeedsId: '[dsh-safe] restore 需要 --id <id>（可重复）或 --all',
  restored: '已恢复',
  restoredDry: '（dry-run）将恢复',
  noMatching: '[dsh-safe] 没有匹配的隔离记录',
  stillQuarantined: '[dsh-safe] {profile} 仍隔离 {count} 行；重启 dsh 生效。',
  ledgerCleared: '[dsh-safe] 该 profile 的隔离名单已清空；重启 dsh 生效。',
  maxRetriesInvalid: '[dsh-safe] --max-retries 需要一个非负整数',
  dryRunNotice: '[dsh-safe] dry-run：只报告，不修改文件。',

  // ---- wrap.js ----
  spawnFailed: '[dsh-safe] 无法启动 {command}: {message}',
  pluginPassthrough: '[dsh-safe] `dsh plugin` 为 pnpm 转发，不做隔离，原样透传。',
  noProfile:
    '[dsh-safe] 未能从参数确定 profile（launcher 旗标需在最前，或用 --profile <name>），无法自动隔离，原样透传。',
  skipFirstParty:
    '[dsh-safe] 跳过第一方插件 {name} (id: {id}) —— 默认保护 @deepseek-ai/*，需要手动处理；确认要禁用可加 --allow-first-party。',
  nothingFound: '[dsh-safe] 报错里没有识别出可自动隔离的已挂载插件，原样透传。',
  maxRetriesReached: '[dsh-safe] 已达最大重试次数（--max-retries {count}），不再重试。',
  disabled: '已禁用',
  willDisable: '（dry-run）将禁用',
  reasonIndent: '           原因: {reason}',
  retrying: '[dsh-safe] 重试启动…',

  // ---- update.js ----
  updateDshNotFound: '[dsh-safe] 在 PATH 上找不到 dsh 命令，无法升级。',
  updatePlan: '[dsh-safe] dsh {name} {old} → {target} ({pm})',
  updateInstallCmd: '[dsh-safe] 即将执行: {command}',
  updateConfirm: '继续? [y/N] ',
  updateNonInteractive: '[dsh-safe] 当前不是交互终端，无法确认；加 -y 跳过确认后重试。',
  updateAborted: '[dsh-safe] 已取消。',
  updateInstalling: '[dsh-safe] 正在升级 dsh…',
  updateInstallFail: '[dsh-safe] 升级失败（退出码 {code}），未恢复任何隔离插件。',
  updateLatestFetchFail: '[dsh-safe] 无法获取 {name} 的最新版本（{pm} view 失败）；可用 --to <版本> 指定目标版本。',
  updateSkipCheckWarn: '[dsh-safe] 无法检查 dsh 更新（{pm} view 失败），跳过升级直接启动。',
  updateAlreadyLatest: '[dsh-safe] dsh 已是 {version}，无需更新。',
  updateDone: '[dsh-safe] dsh 已更新: {old} → {new}',
  updateVerifyWarn: '[dsh-safe] 警告：升级后无法重新解析 dsh 版本，请自行确认。',
  updateNothingToRestore: '[dsh-safe] 没有需要恢复的隔离记录。',
  updateRestoredProfile: '[dsh-safe] 已恢复 {count} 个被隔离的插件 (profile: {profile})',
  updateRestoreSkipped: '[dsh-safe] 已按 --no-restore 跳过恢复；可稍后用 dsh-safe restore --profile <名> --all 恢复。',
  updateVerifyHint: '[dsh-safe] 请启动 dsh 验证；仍不兼容的插件会自动再次隔离。',
  updateRollbackHint: '[dsh-safe] 如需回滚: dsh-safe update --to {version}',
  updateUnknownFlag: '[dsh-safe] update 无法识别的参数: {arg}',
  updatePmInvalid: '[dsh-safe] --pm 只支持 npm 或 pnpm。',
}

const EN = {
  // ---- cli.js ----
  helpText: `dsh-safe {version} — startup fuse for dsh

When a community plugin is incompatible with the dsh runtime, dsh fails to boot as a
whole. dsh-safe wraps dsh: on startup failure it identifies the broken plugin from
the error, marks its row disabled in the profile patch (recording it in a quarantine
ledger), and retries automatically.

Usage:
  dsh-safe <dsh args…>             wrap and run dsh, e.g. dsh-safe web
  dsh-safe -u [<dsh args…>]         upgrade dsh first (skip if latest), then boot
  dsh-safe list [--profile <name>] show quarantined plugins (defaults to all profiles)
  dsh-safe restore --profile <name> (--id <id> | --all) [--dry-run]
                                    re-enable auto-disabled plugins (after a fixed plugin upgrade)
  dsh-safe update [-y] [--to <ver>] [--no-restore] [--pm npm|pnpm]
                                    upgrade dsh and auto-restore quarantined plugins
  dsh-safe help                     show this help
  dsh-safe --version                show version

Wrapper-mode options (must come before the profile / subcommand):
  --dry-run                parse and report only; no files are modified
  --max-retries <n>        max startup retries after an auto-quarantine (default 2)
  --allow-first-party      allow auto-disabling @deepseek-ai/* first-party plugins (skipped by default)

Notes:
  - Rows are disabled via a marker-commented managed block appended to the patch file;
    user content is untouched. Restore with dsh-safe restore, or delete the block manually.
  - Only startup-phase failures are quarantined (module resolution / apply throw /
    missing injected service); runtime uncaught exceptions stay under dsh's own
    fail-loud policy.
  - Output language follows LC_ALL / LC_MESSAGES / LANG / LANGUAGE (zh* → Chinese,
    otherwise English); force it with DSH_SAFE_LANG=zh|en.
`,
  unknownName: '(unknown package)',
  quarantinedAt: '      quarantined at {time}',
  reasonLine: '      reason: {reason}',
  locationLine: '      location: {file}',
  noRecordsProfile: '{profile}: no quarantine records',
  noRecords: 'no quarantine records',
  restoreNeedsProfile: '[dsh-safe] restore requires --profile <name>',
  restoreNeedsId: '[dsh-safe] restore requires --id <id> (repeatable) or --all',
  restored: 'restored',
  restoredDry: '(dry-run) would restore',
  noMatching: '[dsh-safe] no matching quarantine records',
  stillQuarantined: '[dsh-safe] {profile} still has {count} quarantined row(s); restart dsh to apply.',
  ledgerCleared: '[dsh-safe] quarantine list for this profile is now empty; restart dsh to apply.',
  maxRetriesInvalid: '[dsh-safe] --max-retries requires a non-negative integer',
  dryRunNotice: '[dsh-safe] dry-run: report only, no files will be modified.',

  // ---- wrap.js ----
  spawnFailed: '[dsh-safe] failed to start {command}: {message}',
  pluginPassthrough: '[dsh-safe] `dsh plugin` is a pnpm forwarder; no quarantine, exit code passed through.',
  noProfile:
    '[dsh-safe] could not determine the profile from args (launcher flags must come first, or use --profile <name>); no auto-quarantine, exit code passed through.',
  skipFirstParty:
    '[dsh-safe] skipping first-party plugin {name} (id: {id}) — @deepseek-ai/* is protected by default; handle manually, or pass --allow-first-party to allow disabling.',
  nothingFound:
    '[dsh-safe] no mounted plugin could be identified as auto-quarantinable from the error; exit code passed through.',
  maxRetriesReached: '[dsh-safe] max retries reached (--max-retries {count}); giving up.',
  disabled: 'disabled',
  willDisable: '(dry-run) would disable',
  reasonIndent: '           reason: {reason}',
  retrying: '[dsh-safe] retrying…',

  // ---- update.js ----
  updateDshNotFound: '[dsh-safe] could not find the `dsh` command on PATH; nothing to upgrade.',
  updatePlan: '[dsh-safe] dsh {name} {old} → {target} ({pm})',
  updateInstallCmd: '[dsh-safe] about to run: {command}',
  updateConfirm: 'continue? [y/N] ',
  updateNonInteractive: '[dsh-safe] not an interactive terminal; re-run with -y to skip the confirmation.',
  updateAborted: '[dsh-safe] cancelled.',
  updateInstalling: '[dsh-safe] upgrading dsh…',
  updateInstallFail: '[dsh-safe] upgrade failed (exit code {code}); no quarantined plugins were restored.',
  updateLatestFetchFail: '[dsh-safe] could not fetch the latest version of {name} ({pm} view failed); specify a target with --to <version>.',
  updateSkipCheckWarn: '[dsh-safe] could not check for dsh updates ({pm} view failed); starting without upgrading.',
  updateAlreadyLatest: '[dsh-safe] dsh is already {version}; nothing to update.',
  updateDone: '[dsh-safe] dsh updated: {old} → {new}',
  updateVerifyWarn: '[dsh-safe] warning: could not re-resolve the dsh version after the upgrade; please verify manually.',
  updateNothingToRestore: '[dsh-safe] no quarantine records to restore.',
  updateRestoredProfile: '[dsh-safe] restored {count} quarantined plugin(s) (profile: {profile})',
  updateRestoreSkipped: '[dsh-safe] restore skipped due to --no-restore; restore later with dsh-safe restore --profile <name> --all.',
  updateVerifyHint: '[dsh-safe] start dsh to verify; plugins still incompatible will be auto-quarantined again.',
  updateRollbackHint: '[dsh-safe] to roll back: dsh-safe update --to {version}',
  updateUnknownFlag: '[dsh-safe] unrecognized argument for update: {arg}',
  updatePmInvalid: '[dsh-safe] --pm only accepts npm or pnpm.',
}

const CATALOG = { zh: ZH, en: EN }

/** 把 locale 值归一成 'zh' | 'en'；空值 / C / POSIX 返回 null（交给下一优先级）。 */
function parseLocale(raw) {
  if (!raw) return null
  const base = raw.split(':')[0].split('.')[0].split('@')[0].trim().toLowerCase()
  if (!base || base === 'c' || base === 'posix') return null
  return base.startsWith('zh') ? 'zh' : 'en'
}

/**
 * 纯函数，方便单测。默认参数取真实环境。
 * @param {Record<string, string | undefined>} env
 * @param {string} [intlLocale] 环境变量全部缺失时的兜底（生产为 Node 的 Intl 默认 locale）
 */
export function detectLocale(env = process.env, intlLocale = Intl.DateTimeFormat().resolvedOptions().locale) {
  for (const key of ['DSH_SAFE_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE']) {
    const lang = parseLocale(env[key])
    if (lang) return lang
  }
  return typeof intlLocale === 'string' && intlLocale.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

let cached

/** 当前进程的输出语言（首次调用时检测并缓存）。 */
export function getLocale() {
  return (cached ??= detectLocale())
}

/** 指定语言取词条，主要用于单测。 */
export function translate(locale, key, params = {}) {
  const text = CATALOG[locale]?.[key] ?? CATALOG.en[key] ?? key
  return text.replace(/\{(\w+)\}/g, (match, name) => (params[name] !== undefined ? String(params[name]) : match))
}

/** 按当前语言取词条并做 {name} 插值。 */
export function t(key, params = {}) {
  return translate(getLocale(), key, params)
}
