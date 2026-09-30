# dsh-safe · dsh 启动保险丝

中文 | [English](./README.en.md)

> **通道适用性（先看这条）**：dsh **0.1.6 之前**（npm `latest` 目前仍是 0.1.5-rc.3）任何插件失败都会让启动整体失败，dsh-safe 的**自动隔离**在这条通道上依然有效。dsh **0.1.6 起**（`next` / `alpha` 通道，含 0.1.7-rc.x）官方改成只对 required 条目致命、其余条目失败仅告警且启动照常成功——此时 dsh-safe **不写任何文件**，只做**只读巡检**：把未激活的插件、原因与修复方式列出来。两种模式都在包装启动里自动选择，不需要配置。

DeepSeek Harness（DSH）的社区插件与 dsh 运行时不兼容时，dsh **0.1.6 之前**会让 `dsh web` **整体启动失败**——加载器把所有 patch 层拉平成同一棵加载树，任何一个插件 import 失败、`apply` 抛错、或等不到注入的服务，启动审计就会拒绝整棵树，进程退出。此时只能手动编辑 `cordis.patch.yml` 把坏插件禁用。

**dsh-safe 把这个手动动作自动化了**：包装运行 `dsh`，启动失败时从报错里识别坏插件，在 profile patch 里把对应行置为 `disabled: true`（记录进隔离台账），然后自动重试。坏插件只影响自己，dsh 照常启动。

dsh **0.1.6 起**官方换了策略（`packages/boot/app-boot` 的 `auditStartupEntries`）：只有全局 required 条目（`agent-loop` / `webserver` / `modules` / `connection` / `headless-runner` / `acp` / `sdk-jsonrpc-server`）失败才致命，**其余条目失败只打一行 warning 就继续启动**。插件于是变成"静默缺席"：功能没了，而 `$DSH_HOME/logs/startup-*.log` 只对致命失败写、那行 stderr 警告是唯一线索（GUI 启动时甚至看不到）。dsh-safe 在这种情况下改做**只读巡检**——把 `warning: N entries did not activate` 整理成清单和修复指引，**不改 patch、不写台账、不重试**。


## 安装

```bash
npm install -g @hyzyn/dsh-safe
```

要求 Node >= 20，本机已安装 `dsh` 命令。零运行时依赖。

## 快速开始

把平时的 `dsh` 换成 `dsh-safe` 即可，推荐直接用 `-u`（更新并启动）：dsh 有新版本时先升级并恢复被隔离的插件再启动，已最新时和普通启动完全一样：

```bash
dsh-safe -u web       # 推荐：更新并启动（含自动隔离）
dsh-safe web          # 不检查更新，直接带自动隔离启动
dsh-safe --profile tui --patch ./extra.yml
```

`-u` 每次启动多做一次版本检查（需要联网，检查失败只告警、照常启动）；离线或脚本环境用第二行即可。

输出示例（坏插件被自动隔离后重试）：

```
Error: dsh: plugin tree failed to load: failed to apply loader entry smoke-broken (@smoke/broken-impl): Cannot find package '@smoke/broken-impl' ...
[dsh-safe] 已禁用 @smoke/broken-impl (id: smoke-broken) → /Users/me/.dsh/profiles/web/cordis.patch.yml
           原因: Error: failed to import loader entry smoke-broken (@smoke/broken-impl): Cannot find package …
[dsh-safe] 重试启动…
```

## 命令与参数

### 子命令

| 命令 | 说明 |
| --- | --- |
| `dsh-safe <dsh 参数…>` | 包装运行 dsh（把平时的 `dsh` 换成 `dsh-safe`） |
| `dsh-safe -u [update 选项] [dsh 参数…]` | 先升级 dsh 与 dsh-safe 自身（已最新则跳过），再按包装模式启动；不接任何 dsh 参数时只升级、不启动；`--update` 等价 |
| `dsh-safe update [选项]` | 只升级不启动，选项见下 |
| `dsh-safe list [--profile <名>] [--json]` | 查看隔离名单（`--json` 输出结构化 JSON，缺省全部 profile） |
| `dsh-safe doctor` | 环境体检：版本、DSH_HOME、profiles、台账、各 patch 健康度 |
| `dsh-safe restore [--profile <名>] (--id <id> \| --all) [--dry-run]` | 恢复被自动禁用的插件（省略 `--profile` 时遍历台账全部 profile） |
| `dsh-safe explain [id] [--profile <名> \| --file <路径>]` | 用 AI 解读失败信息：指定 `id` 解读该条隔离记录（给 repair 建议）；默认解读最近一次失败日志，无日志则解读隔离台账；`--file`/stdin 读任意日志（需 `DSH_SAFE_AI_KEY`） |
| `dsh-safe repair [id] [--all] [--profile <名>] [--to <版本>] [-y] [--dry-run]` | 重装/升级被隔离的插件并自动恢复（限重装/升级可能修复的失败：包解析失败、导出版本不匹配等；经 `dsh plugin` 的 pnpm 通道安装）；重复挂载类支持自动去重（交互选择保留哪个来源，从 bundles 移除冗余）；适合交给 web UI 里的 AI agent 执行 |
| `dsh-safe help`（`-h` / `--help`） | 显示帮助 |
| `dsh-safe --version`（`-V`） | 显示版本 |

短选项都有等价的长形式（`-u` = `--update`、`-y` = `--yes`、`-h` = `--help`、`-V` = `--version`）；单字母用 `-`，多字母用 `--`。

### 包装模式选项（必须写在第一个位置参数之前）

| 选项 | 说明 |
| --- | --- |
| `--dry-run` | 只解析与报告，不修改任何文件 |
| `--max-retries <n>` | 自动隔离后最多重试启动的次数（默认 2；`0` 表示不隔离只透传） |
| `--allow-first-party` | 允许自动禁用 `@deepseek-ai/*` 第一方插件，duplicate 去重时允许移除官方 bundle（默认跳过，需手动处理） |
| `--exclude <id或包名>` | 隔离豁免名单（可重复），命中的行永不自动禁用；也可写进 `config.json` |

### update / -u 选项（写在 `-u` 或 `update` 之后；其前的包装旗标照常生效）

| 选项 | 说明 |
| --- | --- |
| `-y` / `--yes` | 跳过升级确认（非交互终端必须显式加 `-y`） |
| `--to <版本\|tag>` | 指定 dsh 的目标版本（也接受 dist-tag，如 `next` / `alpha`），也是回滚方式（显式允许降级）；dsh-safe 自身始终升到最新 |
| `--check` | 只报告会不会升级、升到什么（含 `latest` 之外的通道差距），不提示、不安装、不启动；非交互环境无需 `-y` |
| `--self` | 只更新 dsh-safe 自身，不动 dsh 与隔离状态 |
| `--no-restore` | 升级 dsh 后不自动恢复被隔离的插件 |
| `--no-verify` | 跳过升级后的解析器自校验（临时 profile 试启新版 dsh，验证报错识别仍有效） |
| `--pm <npm\|pnpm>` | 强制指定包管理器（缺省自动探测） |

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `DSH_SAFE_LANG=zh\|en` | 强制提示信息语言（缺省跟随 `LC_ALL` / `LC_MESSAGES` / `LANG` / `LANGUAGE`） |
| `DSH_SAFE_NO_UPDATE_CHECK=1` | 关闭启动期的更新提示（`-u <dsh 参数>` 每次启动会报的「已是最新 / 有更新」状态与 `latest` 之外通道差距提示，以及每天最多一次的 dsh-safe 新版提示）；显式 `update` / `--check` 不受影响 |
| `DSH_HOME` | dsh 的 home 目录（dsh 自己的环境变量；隔离台账与各 patch 路径随之） |
| `DSH_SAFE_AI_KEY` | AI 功能 key（未设置 = AI 整体禁用）；默认对接 DeepSeek |
| `DSH_SAFE_AI_BASE_URL` | AI 接口地址（OpenAI 兼容），默认 `https://api.deepseek.com` |
| `DSH_SAFE_AI_MODEL` | AI 模型，默认 `deepseek-chat` |
| `DSH_SAFE_AI_RECOVER=1` | 正则识别不出坏插件时启用 AI 兜底（结果仍走同一隔离管线） |

升级行为：`dsh-safe update` 自动探测 dsh 的包名与安装方式（npm / pnpm 全局安装）、对比最新版本后代跑升级，完成后自动恢复所有被隔离的插件——新 dsh 下仍不兼容的会在下次启动时再次被自动隔离。日常把 `dsh-safe -u web` 当启动命令即可：dsh 已是最新时打一行状态后直接启动（仅一次版本检查），有更新时先升级并恢复隔离再启动，更新检查失败只告警、照常启动。`-u` 后可接 update 的选项（如 `-u -y web`）与包装旗标（如 `-u --max-retries 0 web`）。

版本通道：只跟随 npm 的 `latest`（一次 `npm view <包> dist-tags --json` 拿到全部通道，不额外增加启动开销）。上游常把新版本先发在 `next` / `alpha` 等通道上，于是会出现「`latest` 已是最新，但某个通道更新」——此时会报告「latest 通道已是最新」**并跟通道差距提示——每个比本地新的通道各一行，按版本升序**（如 `next 通道已有 0.1.5-rc.2` 之后跟 `alpha 通道已有 0.1.6-alpha.1`；曾经只报版本最高的那个，next 就被 alpha 盖掉了），且绝不自动升级过去（dsh-safe 不替用户决定上未发布通道）。想跟进就显式 `dsh-safe update --to <tag>`（`next` / `alpha` 都行）。通道名不写死，上游以后加 `beta` / `canary` 也照报。启动路径也每次都报：`-u`、`update`、`--check` 一视同仁，不存在"加了 dsh 参数就沉默"的差异（曾经有过每天一次的闸，观感是"时有时无"，已取消）；日常启动嫌吵就用 `DSH_SAFE_NO_UPDATE_CHECK=1` 整体关掉。想知道「会不会升、升到什么」而不做任何改动，用 `dsh-safe update --check`。

## 工作原理

1. **识别失败**：dsh 启动失败时，stderr 里有五类特征（`plugin(s) failed to load: …`、`N entries did not activate` 逐行失败、`failed to apply/import loader entry <id> (<name>)`、外层栈 `…#<entryId>`、`duplicate loader entry id: <id>` 重复挂载）。dsh-safe 从中提取坏插件的包名与行 id。这五类是 **dsh ≤ 0.1.5** 的报错形态；0.1.6 起多出两种**结构化**诊断，走独立解析（见下一条）。

   **dsh ≥ 0.1.6 的两种结构化诊断**（独立解析，不靠正则猜自由文本）：宽容告警 `dsh: warning: N entries did not activate` + 每行 `<行id> (<包名>): <原因>`；致命诊断 `dsh: startup failed: N required plugins did not activate` + `Failed plugins (N):`（`  <行id> (required)` / `    Package: <包名>` / 缩进原因）与 `Plugins waiting for services (N):` 两个小节。行 id、包名、**required 标记**与原因都直接取自官方输出，比旧格式可靠；被这些结构消费掉的行会排除在旧规则之外（否则 `    Package: x` / `    Error: …` 会被读成假包名 `Package` / `Error`——0.17.0 在 0.1.7-rc.2 上实测如此）。

   **required 条目永不隔离**：致命诊断里带 `(required)` 的行 id（`webserver` / `connection` / `agent-loop` 等）就是"启动了也等于没启动"的那几个，禁用它修不好任何问题，因此与核心依赖同等保护，任何旗标都不放开。

   **例外——环境类失败不隔离**：若 stderr 里出现 errno 形式的环境错误（`EADDRINUSE` 端口被占、`EACCES`/`EPERM` 权限、`ECONNREFUSED`/`ENOTFOUND` 网络等），dsh-safe 判定这次失败**不能归因到插件**，一律不写任何文件、直接透传退出码并说明原因。原因是：环境问题会让健康的插件也失败（例如 `webServer` 的提供者 webserver 因端口 3080 被另一个 dsh 实例占用而 apply 失败时，依赖它的插件只会表现为 `pending (waiting for service: webServer)`），此时任何隔离决定都是误判，而隔离是持久写入。修好环境后重启即可，插件始终保持启用。
2. **对照真实行**：扫描 profile patch、`$DSH_HOME/cordis.patch.yml`（home 层）与各 bundle 的 patch，得到「行 id ↔ 插件包名」对照表；只禁用真实存在的行，避免误伤。官方 bundle（`@deepseek-ai/dsh-base`、`dsh-web-app` 等）**不在 profile 的 `node_modules` 里**，而是装在 dsh 自己的安装目录下——那里也会被扫描（标记为 internal，只用于包名与来源解析，不参与 duplicate 来源判定，去重行为不受影响）。
3. **写入托管区块**：在对应 patch 文件末尾追加带标记注释的区块（与 `dsh-mcp-config managed` 同款约定），把命中的行置为 `disabled: true`。用户已有内容与注释原样保留；全新 profile 的 `[]` 模板会被正确替换成块序列。
4. **台账与恢复**：隔离记录存 `$DSH_HOME/dsh-safe/quarantine.json`。插件升级修复后用 `dsh-safe restore --profile web --all` 摘除区块恢复挂载（`patchReload: live` 的 profile 热生效）。

### 只读巡检（dsh ≥ 0.1.6）

官方在 0.1.6 起把非 required 条目的失败降级为一行 warning，启动照常成功——**隔离路径再也不会被触发**（唯一还会致命的是 required 条目，而它们被上面的规则保护）。代价是插件静默缺席：功能没了、官方不落任何报告、GUI 启动时连那行 stderr 都看不到。

dsh-safe 因此在启动成功时多做一次**只读巡检**：解析 `warning: N entries did not activate`，把每个未激活条目的行 id、包名、原因列出来，并给出修复入口。输出形如：

```
[dsh-safe] 启动成功，但有 1 个插件未激活（dsh 0.1.6+ 只对 required 条目致命，其余仅告警——插件会静默缺席）：
  badplug (@acme/broken-plugin): failed to import
[dsh-safe] 以上条目本次未改动任何文件；重装/升级: dsh-safe repair <id>，解读: dsh-safe explain。
```

巡检**只读**：不改 patch、不写台账、不重试，`--dry-run` 与正常启动行为一致；没有未激活条目时一个字都不输出。修复走 `dsh-safe repair <id>`（经 `dsh plugin` 的 pnpm 通道重装/升级）或手动处理，随后重启验证。

### AI 能力（可选）

设置 `DSH_SAFE_AI_KEY` 后启用（默认对接 DeepSeek，OpenAI 兼容接口，可用 `DSH_SAFE_AI_BASE_URL` / `DSH_SAFE_AI_MODEL` 换任何兼容服务）：

- **`dsh-safe explain [id] [--profile <名> | --file <路径>]`**：解读 dsh-safe 所知的失败信息——指定 `id` 时解读该条隔离记录并给出 `repair` 建议；默认解读最近一次启动失败（stderr 自动持久化到 `$DSH_HOME/dsh-safe/last-failure-<profile>.log`）；无日志时解读隔离台账；`--file`/stdin 读任意日志。纯只读，不碰 patch/台账。
- **AI 兜底识别**（`DSH_SAFE_AI_RECOVER=1`）：正则特征识别不出坏插件时（如 dsh 升级换格式），让 AI 从 stderr 里挑元凶——**结果必须仍走同一验证管线**（对照真实 patch 行、第一方保护、dry-run 预览），命中不了照旧透传。仅在启动失败时调用。
- 隐私：发送前 home 路径脱敏为 `~`；AI 任何失败都静默降级。

### 让 web UI 里的 AI agent 接管修复（推荐）

包装启动自带完整的保活：插件失败自动隔离重试，重复挂载自动去重后重试。启动成功后，台账里留下的记录就是"待修复清单"——把修复交给 web UI 里的 AI agent。将下面片段加入 dsh 的 Agent 预设（或系统提示），agent 就能主动发现并修复：

```text
本机装有 dsh-safe（dsh 的启动保险丝）。当用户报告插件功能缺失、启动
警告或插件行为异常时：
1. 运行 dsh-safe list --json 查看隔离台账（哪些插件被自动禁用、原因、时间）。
   启动输出里的"[dsh-safe] 启动成功，但有 N 个插件未激活"是 dsh 0.1.6+
   的只读巡检清单（这些条目没被禁用，只是没挂载上），同样按第 3 步处理。
2. 需要解读时运行 dsh-safe explain <id>（设置 DSH_SAFE_AI_KEY 后可用）。
3. 按原因修复：
   - 包缺失/版本落后 → dsh-safe repair <id> -y（重装 latest）
   - 已知兼容版本 → dsh-safe repair <id> --to <版本> -y（降级/指定版本）
   - 重复挂载 → dsh-safe repair <id> -y（自动移除冗余挂载来源）
   - 上游暂无兼容版本 → 保持禁用，并向用户说明。
4. 修复后用 dsh-safe --profile <名> 重启验证；仍失败的会被自动重新隔离，
   不会拖垮启动。
```

## 安全边界

- **核心依赖永不自动禁用**：dsh 自身依赖的条目——官方插件（`@deepseek-ai/*`）、由官方 bundle 挂载的行、加载器机制层（`include` / `cordis:*`）、web UI 宿主入口 `webserver`——**任何情况下都不参与自动隔离**，也不受任何旗标影响。三条信号互相独立（行是否属于上述保留条目 / 行是否由官方 bundle 挂载 / 包名是否属于官方命名空间），任一成立即受保护；判断用的包名还会依次从 patch 行、同 id 的其它层、**报错文本本身**回退取得，所以 profile 覆盖行不重述 name（如 webserver 的 host/port 覆盖）也不会让保护失效。
- **包名无法确定的行同样不隔离**：既不能确认它是普通第三方，就不能排除它是核心依赖——按核心对待（fail closed）。隔离是持久写入，宁可漏隔离也不误伤；确实需要禁用请手动编辑 patch。
- **`--allow-first-party` 只作用于 duplicate 去重**：去重（从 manifest 移除重复挂载来源）仍保留显式旗标与交互确认，缺省保留官方来源；**隔离路径不受该旗标影响**，核心依赖没有任何旗标可以放开。
- **duplicate 去重同受保护**：缺省保留官方来源，移除官方 bundle 需显式允许或交互确认，避免连带卸载 webserver 等官方行。
- **环境类失败不隔离**：stderr 里出现 `EADDRINUSE` / `EACCES` / `ECONNREFUSED` 等 errno 时，判定失败不能归因到插件，一律不写任何文件并原样透传退出码。
- **required 条目永不隔离**：dsh ≥ 0.1.6 的致命诊断里带 `(required)` 标记的行 id 与核心依赖同等保护——它是 dsh 跑起来的最低要求，禁用它只会把"启动失败"换成"启动了但不可用"，任何旗标都不放开。
- **只动启动期失败**：模块解析失败 / `apply` 抛错 / 等不到注入服务。运行期的未捕获异常仍由 dsh 自身的 fail-loud 策略处理，不属于启动隔离范围。
- **只读巡检不写盘**：dsh ≥ 0.1.6 的宽容启动路径只解析、只报告，不碰 patch / 台账 / manifest；`--dry-run` 与正常启动的巡检行为完全一致。
- **可审计**：每次写入都带原因与时间戳；`--dry-run` 可以先看会禁用谁。
- **原样透传**：识别不出坏插件、超过重试上限、`dsh plugin`（pnpm 转发）等情况，退出码原样透传，不做任何修改。

## 已知限制

- patch 文件本身 YAML 解析错误（如手改坏了）时无法识别插件，只会透传。
- `--patch` 覆盖层里插入的行不参与对照表（对照表只扫 profile patch、home patch 与 bundle patch）。
- 为了捕获 stderr，包装器把 dsh 的 stderr 接到管道（内容仍实时回显到终端）；stdout/stdin 直通不受影响。
- 本项目针对 dsh 0.1.x 的报错格式做匹配（≤ 0.1.5 的五类自由文本特征 + ≥ 0.1.6 的两种结构化诊断）；dsh 大版本升级后格式变化时需要同步更新解析器。缓解：update/-u 升级 dsh 后会自动做解析器自校验——临时 profile 试启新版 dsh 并确认报错仍可识别，失配当场告警（`--no-verify` 跳过）。注意在 dsh ≥ 0.1.6 上，这个自校验会因"坏插件试启意外成功"而报未验证——那是宽容启动的预期行为，不是解析器坏了（此时隔离路径本就无触发面，巡检路径另有测试覆盖）。
- Windows 为尽力支持：update / --self / list / restore 已适配（.cmd shim 解析、shell 方式调用 npm/pnpm）；包装启动会把 PATH 上 dsh 的 .cmd/.ps1 shim 解析出内嵌的 node 入口、改为 `node <入口>` 直接启动（.exe 直接运行，shim 解析失败退回 shell 方式），绕开 Node 禁止 spawn .cmd 的限制。这些机器逻辑已在 `windows-latest` 上全量覆盖（见[开发](#开发)），但用的是假 dsh 搭台——真实 dsh 的完整安装流程仍以用户反馈为准。

## 开发

```bash
npm test        # node:test 单元测试 + fake dsh 集成测试
```

CI 矩阵是 macos / ubuntu / **windows** × node 20/22，三个平台都跑 `npm test` 全量。

集成测试会启动真的 `bin/dsh-safe.js`，得先造一个假 dsh，而**造法必须分平台**：POSIX 是无扩展名 shebang 脚本 + symlink + 可执行位；Windows 没有 shebang 机制、无扩展名文件也不可执行，只能用 `.cmd` shim，PATH 还得用 `path.delimiter` 而不是写死的 `:`（写死会让整条 PATH 被当成一个目录项）。手搭 POSIX-only 的 fixture 在 Windows 上会静默失效——**改动只在 Windows 生效时，本地与 macos/ubuntu CI 会全绿**。

新增集成测试请用 [`test-utils/fakebin.js`](./test-utils/fakebin.js) 的 `installFakeDsh` / `installFakePm`。注意两者的 spawn 路径不同：dsh 的 shim 只被**解析**（改走 `node <入口>`，不经过 shell），而包管理器是被**直接 spawn** 的，所以 Windows 下它必须是真能执行的 `.cmd` + `.js`，光"形状可被解析"不够。`test/fakebin.test.js` 用 `platform` 注入在任意平台校验 fixture 的两种形态。

动了 Windows 相关逻辑，**以 `windows-latest` 上的 CI 结果为准，不要以本地绿灯为准**——这类问题的共性是本地算不出来。发布门槛见 [RELEASING.md](./RELEASING.md)。

## License

[MIT](./LICENSE)
