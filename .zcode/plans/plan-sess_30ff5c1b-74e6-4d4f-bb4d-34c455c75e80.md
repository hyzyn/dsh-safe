# dsh-safe 强化路线：四阶段实施计划

按已确认的顺序实施，每阶段一组提交、全部测试通过后再进下一阶段。全程零运行时依赖（AI 用 Node 20 全局 fetch）、所有新文案走 i18n 双语、每个功能配测试，沿用现有模式。

## Phase 1 — 工程地基

1. **CI**（新建 `.github/workflows/ci.yml`）：push/PR 触发，matrix `[macos-latest, ubuntu-latest] × [node 20, 22]`，跑 `npm install && npm test`；生成并提交 `package-lock.json`（当前没有）。
2. **自动发布**（`.github/workflows/release.yml`）：推送 `v*` tag 触发 `npm publish`（用 `NPM_TOKEN` secret）+ `gh release create --generate-notes`。
   - ⚠️ 需要你配合一次：把 npm token 配到仓库 Actions secret（给我 token 我用 `gh secret set NPM_TOKEN` 配，或你手动在 Settings → Secrets 添加）。没配好之前发布仍走手动流程。
3. **解析器语料库**（`test/fixtures/dsh-stderr/*.txt` + 扩展 `failures.test.js`）：收录真实报错样本，覆盖现有 4 类特征各 ≥1 条及变体（逐行失败、外层栈、import/apply 失败），逐文件断言 `parseFailureReport` 提取出的 entryId/包名。dsh 将来改格式时这里先红。

## Phase 2 — 升级后解析器自校验

- `lib/verify.js` 新增 `verifyParser()`：dsh 更新成功后（`dshUpdated`）自动执行——在临时 `$DSH_HOME` 里建一次性 profile（patch 行指向现场生成的坏插件目录），用 PATH 上**新装的 dsh** 试启（60s 超时），断言 stderr 能被 `parseFailureReport` + `matchFailures` 识别 → 打印"解析器自校验通过"；识别失败 → 打印警告 + 回滚命令，**不阻断**启动。
- `update`/`-u` 接入（`--no-verify` 跳过）；集成测试用假 dsh 走通"通过/失败"两条路径。
- README 已知限制里的"解析器跟随 dsh 格式"一条补上此缓解措施。

## Phase 3 — AI：explain + 兜底识别

1. **`lib/ai.js`**（零依赖，全局 fetch）：OpenAI 兼容 chat completions，默认 DeepSeek——`DSH_SAFE_AI_KEY`（必需才启用）、`DSH_SAFE_AI_BASE_URL`（默认 `https://api.deepseek.com`）、`DSH_SAFE_AI_MODEL`（默认 `deepseek-chat`）；30s 超时、失败返回 null 完全静默。发送前脱敏：用户 home 路径替换为 `~`。
2. **`dsh-safe explain`**：读 stdin 或 `--file <path>` 的启动失败 stderr，输出人话解读 + 修复建议（输出语言跟随 locale）。纯只读，不碰文件。
3. **AI 兜底识别**（opt-in：env `DSH_SAFE_AI_RECOVER=1`）：`wrap.js` 的 `nothingFound` 分支先走 AI 提取 `{packageName, entryId}`，结果**必须命中 knownrows 真实行**并经过与正则识别完全相同的安全管线（第一方保护、max-retries、dry-run）才隔离；提示行标注"（AI 识别）"，未命中照旧透传。仅在启动失败时调用，控制成本。
4. 测试：单测里替换 `globalThis.fetch` 为桩（假响应），覆盖成功/超时/坏 JSON/未命中四条路径。

## Phase 4 — 体验细节

1. **`dsh-safe doctor`**：一条命令体检——dsh 版本、自身版本、DSH_HOME、profiles 列表、台账（隔离条数与最旧时间）、各 patch 文件 YAML/managed 区块健康度。
2. **隔离豁免名单**：`$DSH_HOME/dsh-safe/config.json`（`{ "exclude": ["id 或包名"] }`，新增 `lib/config.js`）+ 包装模式可重复旗标 `--exclude <id>`，两者合并生效；豁免命中时打一行"按豁免名单跳过"。
3. **`list --json`**；**`restore` 省略 `--profile` 时遍历台账全部 profile**（与 update 的恢复逻辑对齐）。

## 发布与版本

- Phase 1+2 完成 → 发 **0.4.0**（走新 release workflow，NPM_TOKEN 未配好则手动）；Phase 3+4 完成 → 发 **0.5.0**。README/help/i18n 随各阶段同步（docs 变更照旧需发版才能上 npmjs）。
- 每阶段一组提交、`npm test` 全绿后 push；预计 6~8 个提交。

## 需要你配合的点

- `NPM_TOKEN`：自动发布的 secret（给我 token 或自行在仓库 Settings 添加）。
- Phase 3 的真实联调需要你的 DeepSeek API key（仅运行时 env，不入库；测试全程用桩）。
