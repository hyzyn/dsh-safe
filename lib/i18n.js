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
  dsh-safe list [--profile <名>] [--json]
                                    查看隔离名单（--json 输出 JSON）
  dsh-safe doctor                   环境体检（版本 / 台账 / patch 健康）
  dsh-safe restore --profile <名> (--id <id> | --all) [--dry-run]
                                    恢复被自动禁用的插件（升级修复后使用）
  dsh-safe update [-y] [--to <版本>] [--self] [--no-restore] [--no-verify] [--pm npm|pnpm]
                                    升级 dsh 与 dsh-safe 自身，并自动恢复被隔离的插件
  dsh-safe explain [id] [--profile <名> | --file <路径>]  用 AI 解读：最近失败日志 / 隔离台账 / 任意日志
  dsh-safe repair [id] [--all] [--profile <名>] [--to <版本>] [-y] [--dry-run]
                                    重装/升级被隔离的插件并自动恢复（--all 批量；限可自动修复类；省略 id 时只有一条记录则直接修）
  dsh-safe -r [dsh 参数…]            先修复全部可修复的隔离记录，再启动（--repair 等价）
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
  - update/-u 会同时检查 dsh 与 dsh-safe 自身；--self 只更新 dsh-safe。
  - 启动时每天最多提示一次 dsh-safe 新版；DSH_SAFE_NO_UPDATE_CHECK=1 关闭。
  - 输出语言跟随 LC_ALL / LC_MESSAGES / LANG / LANGUAGE（zh* 中文，其余英文）；
    可用环境变量 DSH_SAFE_LANG=zh|en 强制指定。
`,
  unknownName: '(未知包名)',
  quarantinedAt: '      隔离于 {time}',
  reasonLine: '      原因: {reason}',
  locationLine: '      位置: {file}',
  noRecordsProfile: '{profile}: 没有隔离记录',
  noRecords: '没有隔离记录',
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
  updatePlan: '[dsh-safe] {label} {name} {old} → {target} ({pm})',
  updateInstallCmd: '[dsh-safe] 即将执行: {command}',
  updateConfirm: '继续? [y/N] ',
  updateNonInteractive: '[dsh-safe] 当前不是交互终端，无法确认；加 -y 跳过确认后重试。',
  updateAborted: '[dsh-safe] 已取消。',
  updateInstalling: '[dsh-safe] 正在升级 dsh…',
  updateInstallFail: '[dsh-safe] 升级失败（退出码 {code}），未恢复任何隔离插件。',
  updateLatestFetchFail: '[dsh-safe] 无法获取 {name} 的最新版本（{pm} view 失败）；可用 --to <版本> 指定目标版本。',
  updateSkipCheckWarn: '[dsh-safe] 无法检查 dsh 更新（{pm} view 失败），跳过升级直接启动。',
  updateAlreadyLatest: '[dsh-safe] 已是最新，无需更新（dsh {dsh} / dsh-safe {self}）。',
  updateDone: '[dsh-safe] dsh 已更新: {old} → {new}',
  updateVerifyWarn: '[dsh-safe] 警告：升级后无法重新解析 dsh 版本，请自行确认。',
  updateNothingToRestore: '[dsh-safe] 没有需要恢复的隔离记录。',
  updateRestoredProfile: '[dsh-safe] 已恢复 {count} 个被隔离的插件 (profile: {profile})',
  updateRestoreSkipped: '[dsh-safe] 已按 --no-restore 跳过恢复；可稍后用 dsh-safe restore --profile <名> --all 恢复。',
  updateVerifyHint: '[dsh-safe] 请启动 dsh 验证；仍不兼容的插件会自动再次隔离。',
  updateRollbackHint: '[dsh-safe] 如需回滚: dsh-safe update --to {version}',
  verifyRunning: '[dsh-safe] 正在自校验解析器：用临时 profile 试启新版 dsh（预期失败）…',
  verifyPassed: '[dsh-safe] 解析器自校验通过：新版 dsh 的报错能被识别，自动隔离可用。',
  verifyFailNoHit: '[dsh-safe] 警告：解析器自校验未通过——无法从新版 dsh 的报错里识别坏插件，自动隔离可能失效；建议回滚（dsh-safe update --to {version}）并反馈给 dsh-safe。',
  verifyFailBoot: '[dsh-safe] 警告：解析器自校验未通过——坏插件试启意外成功，未触发报错，自动隔离未验证。',
  verifyFailTimeout: '[dsh-safe] 警告：解析器自校验未完成（试启超时或无法启动），自动隔离未验证。',
  selfUpdateLagHint: '[dsh-safe] dsh-safe 已更新: {old} → {new}（本次运行仍是旧版，下次启动生效）',
  updateNotify: '[dsh-safe] 提示: dsh-safe 有新版本 {new}（当前 {old}）',
  updateNotifyHow: '           升级: npm i -g {name} 或 dsh-safe update --self',
  updateUnknownFlag: '[dsh-safe] update 无法识别的参数: {arg}',
  updatePmInvalid: '[dsh-safe] --pm 只支持 npm 或 pnpm。',
  updateToInvalid: '[dsh-safe] --to 需要合法的版本号（如 1.2.3 或 1.2.3-rc.1）。',
  aiDisabled: '[dsh-safe] AI 功能未启用：设置环境变量 DSH_SAFE_AI_KEY 后可用（默认对接 DeepSeek，见 README 环境变量表）。',
  aiNoInput: '[dsh-safe] 没有读到任何 stderr 内容：用 --file <路径>，或从 stdin 粘贴后按 Ctrl-D 结束。',
  aiExplainFailed: '[dsh-safe] AI 解读失败（网络或接口异常）；未修改任何文件。',
  aiFileUnreadable: '[dsh-safe] 无法读取文件: {file}',
  aiRecovered: '[dsh-safe] AI 兜底识别出 {count} 个可疑坏插件（结果仍走同一隔离管线）',
  explainHint: '[dsh-safe] 可运行 dsh-safe explain 解读这次失败',
  explainUsingLast: '[dsh-safe] 解读最近一次失败记录: {file}',
  explainNoSource: '[dsh-safe] 没有可解读的内容。用法：dsh-safe explain [--profile <名> | --file <路径>]，或从 stdin 管道输入。\n           包装启动失败时 stderr 会自动存到 $DSH_HOME/dsh-safe/last-failure-<profile>.log。',
  explainLedger: '[dsh-safe] 解读隔离台账（{count} 条）…',
  explainEntry: '[dsh-safe] 解读隔离记录 {id}（profile: {profile}）…',
  explainUnknownArg: '[dsh-safe] explain 无法识别的参数: {arg}',
  excludedByList: '[dsh-safe] 按豁免名单跳过 {label}（不自动禁用）',
  doctorSelf: 'dsh-safe   {version}',
  doctorDsh: 'dsh        {name} {version}',
  doctorDshMissing: 'dsh        未在 PATH 上找到',
  doctorHome: 'DSH_HOME   {home}',
  doctorProfiles: 'profiles   {profiles}',
  doctorLedger: '隔离台账    {count} 条（最早 {oldest}；profile: {profiles}）',
  doctorLedgerEmpty: '隔离台账    无记录',
  doctorPatchOk: 'patch      {file}（{rows} 行；托管区块 {managed}）',
  doctorPatchMissing: 'patch      {file}（不存在）',
  doctorAIOn: 'AI         已启用（模型 {model}）',
  doctorAIOff: 'AI         未启用（DSH_SAFE_AI_KEY 未设置）',
  doctorCheckLast: '更新检查    上次 {time}',
  doctorCheckNever: '更新检查    从未执行',
  repairPickOne: '[dsh-safe] 共 {count} 条隔离记录，指定要修复的 id（dsh-safe repair <id>）：',
  repairNotSupportedTag: '（不支持自动修复）',
  repairEntryMissing: '[dsh-safe] 台账里没有找到 {id} 对应的隔离记录。',
  repairAmbiguous: '[dsh-safe] {id} 在多个 profile 中都有隔离记录（{profiles}），请用 --profile <名> 指定。',
    repairUnsupported: '[dsh-safe] 该失败类型不支持自动修复（可修复范围：包解析失败、导出版本不匹配等重装/升级可能修复的问题）。原因: {reason}\n           可用 dsh-safe explain 查看解读。',
  repairPlan: '[dsh-safe] 将在 profile {profile} 中修复 {name}：执行 {command}，成功后自动摘除隔离行',
  repairDuplicate: '[dsh-safe] 这是重复挂载问题（id: {id}）。一键修复：dsh-safe repair {id}（自动移除冗余来源并恢复挂载）',
  repairDuplicateManual: '[dsh-safe] 这是重复挂载问题（同一 id 被多个 bundle/行挂载），重装包无法修复。请从 profile 的 bundles 清单或 patch 中移除多余的挂载来源，然后 dsh-safe restore 恢复。',
  repairDedupePick: '[dsh-safe] {id} 同时由以下 bundle 挂载，保留哪个来源？',
  repairDedupeDefault: '（bundles 中先声明，缺省保留）',
  repairDedupeChoose: '保留哪个？输入编号 [1]: ',
  repairDedupePlan: '[dsh-safe] 修复方案：保留 {keep} 的挂载，从 bundles 移除 {remove}，并摘除 {id} 的禁用行',
  repairDedupeNoManifest: '[dsh-safe] profile 清单中没有可编辑的 bundles 数组，请手动处理。',
  repairDedupeDone: '[dsh-safe] 去重完成：已从 bundles 移除 {removed}；{keep} 的挂载保留、禁用行已摘除。跑 dsh-safe <启动命令> 验证。',
  repairAllConflict: '[dsh-safe] --all 与 <id> 不能同时使用。',
  repairUnknownArg: '[dsh-safe] repair 无法识别的参数: {arg}',
  repairBatchPlan: '[dsh-safe] 将修复 {count} 条隔离记录: {ids}',
  repairBatchSkip: '[dsh-safe] 跳过 {count} 条（不支持自动修复）: {ids}',
  repairBatchDone: '[dsh-safe] 批量修复完成：成功 {repaired} 条，失败 {failed} 条。',
  repairInstallFailed: '[dsh-safe] 插件安装失败（退出码 {code}），隔离状态保持不变。',
  repairDone: '[dsh-safe] 修复完成：跑 dsh-safe <启动命令> 验证；若仍失败会被自动重新隔离。',
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
  dsh-safe list [--profile <name>] [--json]
                                    show quarantined plugins (--json outputs JSON)
  dsh-safe doctor                   environment check (versions / ledger / patch health)
  dsh-safe restore --profile <name> (--id <id> | --all) [--dry-run]
                                    re-enable auto-disabled plugins (after a fixed plugin upgrade)
  dsh-safe update [-y] [--to <ver>] [--self] [--no-restore] [--no-verify] [--pm npm|pnpm]
                                    upgrade dsh and dsh-safe itself, auto-restore quarantined plugins
  dsh-safe explain [id] [--profile <name> | --file <path>]  interpret with AI: last failure log / ledger / any log
  dsh-safe repair [id] [--all] [--profile <name>] [--to <ver>] [-y] [--dry-run]
                                    reinstall/upgrade quarantined plugins and auto-restore (--all for batch; repairable failures only; omit id when there is exactly one record)
  dsh-safe -r [dsh args…]            repair all repairable quarantined plugins, then boot (--repair alias)
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
  - update/-u checks both dsh and dsh-safe itself; --self updates dsh-safe only.
  - A new-version notice for dsh-safe is shown at most once a day on boot;
    disable it with DSH_SAFE_NO_UPDATE_CHECK=1.
  - Output language follows LC_ALL / LC_MESSAGES / LANG / LANGUAGE (zh* → Chinese,
    otherwise English); force it with DSH_SAFE_LANG=zh|en.
`,
  unknownName: '(unknown package)',
  quarantinedAt: '      quarantined at {time}',
  reasonLine: '      reason: {reason}',
  locationLine: '      location: {file}',
  noRecordsProfile: '{profile}: no quarantine records',
  noRecords: 'no quarantine records',
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
  updatePlan: '[dsh-safe] {label} {name} {old} → {target} ({pm})',
  updateInstallCmd: '[dsh-safe] about to run: {command}',
  updateConfirm: 'continue? [y/N] ',
  updateNonInteractive: '[dsh-safe] not an interactive terminal; re-run with -y to skip the confirmation.',
  updateAborted: '[dsh-safe] cancelled.',
  updateInstalling: '[dsh-safe] upgrading dsh…',
  updateInstallFail: '[dsh-safe] upgrade failed (exit code {code}); no quarantined plugins were restored.',
  updateLatestFetchFail: '[dsh-safe] could not fetch the latest version of {name} ({pm} view failed); specify a target with --to <version>.',
  updateSkipCheckWarn: '[dsh-safe] could not check for dsh updates ({pm} view failed); starting without upgrading.',
  updateAlreadyLatest: '[dsh-safe] already up to date (dsh {dsh} / dsh-safe {self}); nothing to update.',
  updateDone: '[dsh-safe] dsh updated: {old} → {new}',
  updateVerifyWarn: '[dsh-safe] warning: could not re-resolve the dsh version after the upgrade; please verify manually.',
  updateNothingToRestore: '[dsh-safe] no quarantine records to restore.',
  updateRestoredProfile: '[dsh-safe] restored {count} quarantined plugin(s) (profile: {profile})',
  updateRestoreSkipped: '[dsh-safe] restore skipped due to --no-restore; restore later with dsh-safe restore --profile <name> --all.',
  updateVerifyHint: '[dsh-safe] start dsh to verify; plugins still incompatible will be auto-quarantined again.',
  updateRollbackHint: '[dsh-safe] to roll back: dsh-safe update --to {version}',
  verifyRunning: '[dsh-safe] verifying the parser: booting the new dsh with a throwaway profile (expected to fail)…',
  verifyPassed: '[dsh-safe] parser self-check passed: failures from the new dsh are recognized, auto-quarantine is available.',
  verifyFailNoHit: '[dsh-safe] warning: parser self-check failed — the broken plugin could not be recognized in the new dsh errors; auto-quarantine may be broken. Consider rolling back (dsh-safe update --to {version}) and reporting it to dsh-safe.',
  verifyFailBoot: '[dsh-safe] warning: parser self-check failed — the deliberately broken profile booted unexpectedly, no error was triggered; auto-quarantine unverified.',
  verifyFailTimeout: '[dsh-safe] warning: parser self-check did not finish (boot timed out or could not start); auto-quarantine unverified.',
  selfUpdateLagHint: '[dsh-safe] dsh-safe updated: {old} → {new} (this run still uses the old version; takes effect on the next run)',
  updateNotify: '[dsh-safe] notice: a new dsh-safe version is available: {new} (current {old})',
  updateNotifyHow: '           to upgrade: npm i -g {name} or dsh-safe update --self',
  updateUnknownFlag: '[dsh-safe] unrecognized argument for update: {arg}',
  updatePmInvalid: '[dsh-safe] --pm only accepts npm or pnpm.',
  updateToInvalid: '[dsh-safe] --to requires a valid version (e.g. 1.2.3 or 1.2.3-rc.1).',
  aiDisabled: '[dsh-safe] AI is not enabled: set the DSH_SAFE_AI_KEY environment variable (defaults to DeepSeek, see the env table in the README).',
  aiNoInput: '[dsh-safe] no stderr content was read: use --file <path>, or paste to stdin and press Ctrl-D.',
  aiExplainFailed: '[dsh-safe] AI interpretation failed (network or API error); no files were modified.',
  aiFileUnreadable: '[dsh-safe] cannot read file: {file}',
  aiRecovered: '[dsh-safe] AI fallback identified {count} suspected broken plugin(s); the same quarantine pipeline applies',
  explainHint: '[dsh-safe] run dsh-safe explain to interpret this failure',
  explainUsingLast: '[dsh-safe] interpreting the last failure record: {file}',
  explainNoSource: '[dsh-safe] nothing to interpret. Usage: dsh-safe explain [--profile <name> | --file <path>], or pipe via stdin.\n           On wrapped-boot failures stderr is saved to $DSH_HOME/dsh-safe/last-failure-<profile>.log automatically.',
  explainLedger: '[dsh-safe] interpreting the quarantine ledger ({count} record(s))…',
  explainEntry: '[dsh-safe] interpreting quarantine record {id} (profile: {profile})…',
  explainUnknownArg: '[dsh-safe] unrecognized argument for explain: {arg}',
  excludedByList: '[dsh-safe] skipped {label} per the exclusion list (never auto-disabled)',
  doctorSelf: 'dsh-safe   {version}',
  doctorDsh: 'dsh        {name} {version}',
  doctorDshMissing: 'dsh        not found on PATH',
  doctorHome: 'DSH_HOME   {home}',
  doctorProfiles: 'profiles   {profiles}',
  doctorLedger: 'ledger     {count} quarantined (oldest {oldest}; profiles: {profiles})',
  doctorLedgerEmpty: 'ledger     empty',
  doctorPatchOk: 'patch      {file} ({rows} rows; managed block {managed})',
  doctorPatchMissing: 'patch      {file} (missing)',
  doctorAIOn: 'AI         enabled (model {model})',
  doctorAIOff: 'AI         disabled (DSH_SAFE_AI_KEY not set)',
  doctorCheckLast: 'update-check last ran at {time}',
  doctorCheckNever: 'update-check never ran',
  repairPickOne: '[dsh-safe] {count} quarantined record(s); specify the id to repair (dsh-safe repair <id>):',
  repairNotSupportedTag: ' (not auto-repairable)',
  repairEntryMissing: '[dsh-safe] no quarantine record found for {id}.',
  repairAmbiguous: '[dsh-safe] {id} is quarantined in multiple profiles ({profiles}); specify one with --profile <name>.',
    repairUnsupported: '[dsh-safe] this failure type cannot be auto-repaired (repairable: package-resolution failures, export mismatches — problems a reinstall/upgrade may fix). Reason: {reason}\n           try dsh-safe explain for an interpretation.',
  repairPlan: '[dsh-safe] repairing {name} in profile {profile}: running {command}, then the quarantine row is removed automatically',
  repairDuplicate: '[dsh-safe] duplicate-mount issue (id: {id}). One-command fix: dsh-safe repair {id} (removes the redundant source and restores automatically)',
  repairDuplicateManual: '[dsh-safe] duplicate-mount issue (the same id is mounted by multiple bundles/rows); reinstalling cannot fix it. Remove the redundant mount source from the profile bundles/patch, then run dsh-safe restore.',
  repairDedupePick: '[dsh-safe] {id} is mounted by the following bundles; which source to keep?',
  repairDedupeDefault: ' (declared first in bundles; default keep)',
  repairDedupeChoose: 'which one to keep? number [1]: ',
  repairDedupePlan: '[dsh-safe] fix plan: keep {keep} mounted, remove {remove} from bundles, and drop the disabled row for {id}',
  repairDedupeNoManifest: '[dsh-safe] the profile manifest has no editable bundles array; handle it manually.',
  repairDedupeDone: '[dsh-safe] dedupe finished: removed {removed} from bundles; {keep} stays mounted and the disabled row was dropped. Run dsh-safe <boot command> to verify.',
  repairAllConflict: '[dsh-safe] --all and <id> are mutually exclusive.',
  repairUnknownArg: '[dsh-safe] unrecognized argument for repair: {arg}',
  repairBatchPlan: '[dsh-safe] repairing {count} quarantine record(s): {ids}',
  repairBatchSkip: '[dsh-safe] skipping {count} (not auto-repairable): {ids}',
  repairBatchDone: '[dsh-safe] batch repair finished: {repaired} succeeded, {failed} failed.',
  repairInstallFailed: '[dsh-safe] plugin install failed (exit code {code}); quarantine state left unchanged.',
  repairDone: '[dsh-safe] repair finished: run dsh-safe <boot command> to verify; a still-broken plugin will be auto-quarantined again.',
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
