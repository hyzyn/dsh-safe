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
 *
 * 1–3 给出包名（entry.options.name），4 给出行 id；两者都要在调用方与
 * patch 行对照后才会生效，所以这里允许宽收集。
 */

const NAME_CLASS = '[\\w@][\\w@./\\-]*'
const ID_CLASS = '[\\w:\\-]+'

const isPluginName = (s) => NAME_REGEX.test(s)
const NAME_REGEX = new RegExp(`^${NAME_CLASS}$`)

/**
 * @param {string} text dsh 进程捕获到的 stderr
 * @returns {{ names: Array<[string, string]>, entryIds: Array<[string, string]> }}
 *          names: [包名, 出现该命中的原始行]；entryIds: [行 id, 原始行]
 */
export function parseFailureReport(text) {
  const names = new Map()
  const entryIds = new Map()
  const lines = text.split(/\r?\n/)
  const reEntry = new RegExp(`failed to (?:apply|import|dispose|rollback) loader entry (${ID_CLASS}) \\(([^)]+)\\)`)
  const reStackId = new RegExp(`^\\s*at \\S+#(${ID_CLASS})`)
  const reLoadList = /plugin\(s\) failed to load:\s*([^;\n]+);/

  for (const line of lines) {
    const entry = reEntry.exec(line)
    if (entry) {
      entryIds.set(entry[1], line)
      if (isPluginName(entry[2])) names.set(entry[2], line)
    }
    const stackId = reStackId.exec(line)
    if (stackId) entryIds.set(stackId[1], line)
    const list = reLoadList.exec(line)
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
      if (m && isPluginName(m[1])) names.set(m[1], lines[j])
    }
  }

  return { names: [...names], entryIds: [...entryIds] }
}

/** 压缩一行错误为台账里的 reason（去空白、截断）。 */
export function summarizeLine(line, max = 160) {
  if (!line) return 'startup failure'
  const flat = line.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
