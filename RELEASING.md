# 发布流程

目标：让每个版本号值得点开。发布频率是给用户的信号预算——攒批发、过门槛、高危改动走 rc。

## 发布门槛（每次 tag 前过一遍）

1. `npm test` 全绿。本地 `npm publish` 已挂 `prepublishOnly` 闸；CI 在发布前还会再跑一次。
2. **真机启动**：用自己日常的 profile 真实跑一次 `dsh-safe web`。隔离、去重、patch 写入这些路径只有真实启动才走得通——单测绿不等于启动没问题。
3. 动了 patch 写入、quarantine 台账、manifest 编辑的改动，额外跑一次 `dsh-safe --dry-run` 看一眼会写什么。

## 攒批

- 多个 fix 攒一个版本发；feature 单独发。目标一天 ≤ 1–2 个版本。
- 版本号语义：**patch** = 不改行为的修复；**minor** = 新能力或行为变化。用户靠这个决定要不要更。
- 出 hotfix 链（x.y.1 → x.y.2 → x.y.3）通常说明上一版发布前没过门槛——回看是哪步省了，而不是接着发下一版。

## 正式发布

```bash
git switch main && git pull
# …提交改动（工作树不干净时 npm version 会拒绝，正好当门槛）
npm version patch   # 或 minor：自动改 package.json、提交、打 v 前缀 tag，
                    # postversion 脚本会自动 git push（含 tags）
```

tag 推上去后 Release workflow 接管：CI 测试 → 校验 tag 与 package.json 一致 → `npm publish` → 建 GitHub Release。手动打 tag 也可以，但 tag 必须等于 package.json 版本（workflow 会校验，不一致直接红）。

## 高危改动走 prerelease

quarantine 写入、manifest 编辑、dsh 报错解析器这类改动，先发 rc：

```bash
npm version 0.16.0-rc.1   # workflow 检测到 '-' 自动以 --tag next 发布，
                          # GitHub Release 标记为 prerelease
```

- `next` dist-tag 不会进用户的每日版本检查（检查只读 npm `latest`），正式用户无感。
- 自测：`npm install -g @hyzyn/dsh-safe@next`，真实环境跑一天；稳定后 `npm version 0.16.0`（去掉 `-rc.n`）发 latest。rc 用户不会被 `-u` 自动带出 rc（self-update 同样只读 latest），退出 rc 用上面的显式安装即可。
