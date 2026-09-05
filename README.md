<a name="zh"></a>
# dsh-safe · dsh 启动保险丝

中文 | [English](#english)

DeepSeek Harness（DSH）的社区插件与 dsh 运行时不兼容时，`dsh web` 会**整体启动失败**——加载器把所有 patch 层拉平成同一棵加载树，任何一个插件 import 失败、`apply` 抛错、或等不到注入的服务，启动审计就会拒绝整棵树，进程退出。此时只能手动编辑 `cordis.patch.yml` 把坏插件禁用。

**dsh-safe 把这个手动动作自动化了**：包装运行 `dsh`，启动失败时从报错里识别坏插件，在 profile patch 里把对应行置为 `disabled: true`（记录进隔离台账），然后自动重试。坏插件只影响自己，dsh 照常启动。

## 安装

```bash
npm install -g @hyzyn/dsh-safe
```

要求 Node >= 20，本机已安装 `dsh` 命令。零运行时依赖。

## 快速开始

把平时的 `dsh` 换成 `dsh-safe` 即可：

```bash
dsh-safe web          # 等价于 dsh web，带自动隔离
dsh-safe --profile tui --patch ./extra.yml
```

输出示例（坏插件被自动隔离后重试）：

```
Error: dsh: plugin tree failed to load: failed to apply loader entry smoke-broken (@smoke/broken-impl): Cannot find package '@smoke/broken-impl' ...
[dsh-safe] 已禁用 @smoke/broken-impl (id: smoke-broken) → /Users/me/.dsh/profiles/web/cordis.patch.yml
           原因: Error: failed to import loader entry smoke-broken (@smoke/broken-impl): Cannot find package …
[dsh-safe] 重试启动…
```

## 命令

```
dsh-safe <dsh 参数…>             包装运行 dsh
dsh-safe list [--profile <名>]    查看隔离名单（缺省列出全部 profile）
dsh-safe restore --profile <名> (--id <id> | --all) [--dry-run]
                                  恢复被自动禁用的插件（升级修复后使用）
dsh-safe help
```

包装模式选项（必须写在 profile / 子命令之前）：

| 选项 | 说明 |
| --- | --- |
| `--dry-run` | 只解析与报告，不修改任何文件 |
| `--max-retries <n>` | 自动隔离后最多重试启动的次数（默认 2；`0` 表示不隔离只透传） |
| `--allow-first-party` | 允许自动禁用 `@deepseek-ai/*` 第一方插件（默认跳过，需手动处理） |

## 工作原理

1. **识别失败**：dsh 启动失败时，stderr 里有四类特征（`plugin(s) failed to load: …`、`N entries did not activate` 逐行失败、`failed to apply/import loader entry <id> (<name>)`、外层栈 `…#<entryId>`）。dsh-safe 从中提取坏插件的包名与行 id。
2. **对照真实行**：扫描 profile patch、`$DSH_HOME/cordis.patch.yml`（home 层）与各 bundle 的 patch，得到「行 id ↔ 插件包名」对照表；只禁用真实存在的行，避免误伤。
3. **写入托管区块**：在对应 patch 文件末尾追加带标记注释的区块（与 `dsh-mcp-config managed` 同款约定），把命中的行置为 `disabled: true`。用户已有内容与注释原样保留；全新 profile 的 `[]` 模板会被正确替换成块序列。
4. **台账与恢复**：隔离记录存 `$DSH_HOME/dsh-safe/quarantine.json`。插件升级修复后用 `dsh-safe restore --profile web --all` 摘除区块恢复挂载（`patchReload: live` 的 profile 热生效）。

## 安全边界

- **第一方保护**：`@deepseek-ai/*` 的行默认跳过（禁用 `dsh-web-app` 这类插件会让 dsh 失去核心能力），需要 `--allow-first-party` 才会动。
- **只动启动期失败**：模块解析失败 / `apply` 抛错 / 等不到注入服务。运行期的未捕获异常仍由 dsh 自身的 fail-loud 策略处理，不属于启动隔离范围。
- **可审计**：每次写入都带原因与时间戳；`--dry-run` 可以先看会禁用谁。
- **原样透传**：识别不出坏插件、超过重试上限、`dsh plugin`（pnpm 转发）等情况，退出码原样透传，不做任何修改。

## 已知限制

- patch 文件本身 YAML 解析错误（如手改坏了）时无法识别插件，只会透传。
- `--patch` 覆盖层里插入的行不参与对照表（对照表只扫 profile patch、home patch 与 bundle patch）。
- 为了捕获 stderr，包装器把 dsh 的 stderr 接到管道（内容仍实时回显到终端）；stdout/stdin 直通不受影响。
- 本项目针对 dsh 0.1.x 的报错格式做匹配；dsh 大版本升级后格式变化时需要同步更新解析器。

## 开发

```bash
npm test        # node:test 单元测试 + 假 dsh 集成测试
```

<a name="english"></a>
## English

[中文](#zh) | English

**dsh-safe** is a fuse for DeepSeek Harness (DSH) startup: when a community plugin is incompatible with the running dsh version, `dsh web` normally fails to boot entirely — one broken plugin rejects the whole loader tree. dsh-safe wraps any `dsh` invocation, parses the startup-failure diagnostics on stderr, marks the offending patch rows as `disabled: true` inside a managed block in your profile patch file (keeping all user content and comments), records the action in a quarantine ledger, and retries. First-party `@deepseek-ai/*` plugins are protected by default; `dsh-safe restore --profile <name> --all` re-enables quarantined rows after you upgrade the plugin.

```bash
npm install -g @hyzyn/dsh-safe
dsh-safe web                 # run dsh web with auto-quarantine
dsh-safe list                # show quarantined plugins
dsh-safe restore --profile web --all
```

## License

[MIT](./LICENSE)
