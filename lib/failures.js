/**
 * @hyzyn/dsh-safe — 从 dsh 启动失败的 stderr 里识别坏插件。
 *
 * 匹配四类启动失败特征（来自 @deepseek-ai/dsh-app-boot 与
 * @deepseek-ai/cordis-plugin-loader 的真实输出）：
 *
 * 1. assertEntriesLoaded:
 *    `dsh: plugin(s) failed to load: @a/x, @b/y; Cordis startup failed ...`
 * 2. assertEntriesActivated:
 *    `dsh: 2 entries did not activate` 之后每行一条 `@a/x: <错误>` / `@a/x: pending (waiting for service(s): xxx)`
 * 3. loader entry 更新失败：
 *    `failed to (apply|import|dispose|rollback) loader entry <id> (<name>): <原因>`
 * 4. 外层栈（getOuterStack）：
 *    `    at file:///…/profiles/web/#<entryId>`
 * 5. 重复挂载：
 *    `duplicate loader entry id: <id>`（同一 id 被多个 bundle/行挂载）。
 *    该行同时会被特征 3 命中包装层（如 include 入口），但 include 是机制层
 *    而非元凶——命中本特征时抑制同线的特征 3 记录，避免误隔离机制行。
 *
 * 1–3 给出包名（entry.options.name），4 给出行 id；两者都要在调用方与
 * patch 行对照后才会生效，所以这里允许宽收集。
 *
 * 例外：环境类失败（端口被占 / 权限 / 网络不可达）不能归因到插件。这类失败里
 * 插件本身是好的，禁用它既修不好问题、又是持久写入，还会连带误伤依赖其服务的
 * 插件（后者只在 "did not activate" 块里表现为 pending）。命中的条目单独收进
 * environmental，不进隔离候选；调用方见此一律不隔离。
 */

const NAME_CLASS = '[\\w@][\\w@./\\-]*'
const ID_CLASS = '[\\w:\\-]+'

/**
 * 环境类失败的 errno 特征。用 errno 而非错误文案匹配：errno 由 Node 生成、
 * 跨语言稳定，且插件不兼容不会以 errno 形式出现（那是模块解析 / apply 抛错）。
 */
const ENV_ERRNO =
  /\b(?:EADDRINUSE|EADDRNOTAVAIL|EACCES|EPERM|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|EMFILE|ENFILE)\b/

const isPluginName = (s) => NAME_REGEX.test(s)
const NAME_REGEX = new RegExp(`^${NAME_CLASS}$`)

/**
 * @param {string} text dsh 进程捕获到的 stderr
 * @returns {{
 *   names: Array<[string, string]>,
 *   entryIds: Array<[string, string]>,
 *   environmental: Array<[string, string]>,
 * }}
 *   names: [包名, 出现该命中的原始行]；entryIds: [行 id, 原始行]；
 *   environmental: [条目名或行 id, 原始行]——环境类失败，调用方不得据此隔离。
 */
export function parseFailureReport(text) {
  const names = new Map()
  const entryIds = new Map()
  const environmental = new Map()
  const lines = text.split(/\r?\n/)
  const reEntry = new RegExp(`failed to (?:apply|import|dispose|rollback) loader entry (${ID_CLASS}) \\(([^)]+)\\)`)
  const reStackId = new RegExp(`^\\s*at \\S+#(${ID_CLASS})`)
  const reLoadList = /plugin\(s\) failed to load:\s*([^;\n]+);/
  const reDupId = new RegExp(`duplicate loader entry id: (${ID_CLASS})`)

  for (const line of lines) {
    const dup = reDupId.exec(line)
    if (dup) {
      // 重复挂载：真正元凶是被复制的 id；包装行（apply include 等）是机制层，
      // 若一并记录可能误禁加载机制，故本行只记录 duplicate 的 id。
      entryIds.set(dup[1], line)
      continue
    }
    const entry = reEntry.exec(line)
    const stackId = reStackId.exec(line)
    const list = reLoadList.exec(line)
    if (ENV_ERRNO.test(line)) {
      // 环境类失败：本行不作为坏插件候选，只留一条待调用方提示的原因
      environmental.set(entry?.[1] ?? list?.[1]?.trim() ?? stackId?.[1] ?? 'dsh', line)
      continue
    }
    if (entry) {
      entryIds.set(entry[1], line)
      if (isPluginName(entry[2])) names.set(entry[2], line)
    }
    if (stackId) entryIds.set(stackId[1], line)
    if (list) {
      for (const raw of list[1].split(/,\s*/)) {
        const name = raw.trim()
        if (name && isPluginName(name)) names.set(name, line)
      }
    }
  }

  // "did not activate" 块：头部之后的每一行 `包名: …` 都是一条失败。
  // 失败行的错误体可能自带多行栈，所以扫到文本末尾，靠调用方的行名对照收窄。
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('did not activate')) continue
    for (let j = i + 1; j < lines.length; j++) {
      const m = new RegExp(`^\\s*(${NAME_CLASS}):\\s`).exec(lines[j])
      if (!m || !isPluginName(m[1])) continue
      if (ENV_ERRNO.test(lines[j])) environmental.set(m[1], lines[j])
      else names.set(m[1], lines[j])
    }
  }

  return { names: [...names], entryIds: [...entryIds], environmental: [...environmental] }
}

/** 压缩一行错误为台账里的 reason（去空白、截断）。 */
export function summarizeLine(line, max = 160) {
  if (!line) return 'startup failure'
  const flat = line.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
