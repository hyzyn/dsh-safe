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
 * dsh ≥ 0.1.6 起启动审计换了策略（app-boot `auditStartupEntries`）：只有全局
 * required 条目（agent-loop / webserver / modules / connection / headless-runner /
 * acp / sdk-jsonrpc-server）失败才致命，其余条目失败只告警、兄弟插件照常运行。
 * 于是多了两种结构化输出，而特征 1/2 在 0.1.6+ 已不再产生：
 *
 * 6. 宽容告警（可选条目失败，**退出码 0**）：
 *    `dsh: warning: 1 entry did not activate` 之后每行 `<行id> (<包名>): <原因>`
 * 7. 致命诊断（required 条目失败，退出码 1）：
 *    `dsh: startup failed: 1 required plugin did not activate` 之后
 *    `Failed plugins (N):`（`  <行id> (required)` / `    Package: <包名>` / 缩进原因）
 *    与 `Plugins waiting for services (N):`（`  <行id> (required)  <缺失服务>`）两个小节。
 *
 * 6/7 一律走结构化解析：行 id、包名、required 标记与原因都能准确拿到，并且**必须
 * 把消费掉的行排除在旧规则之外**——否则特征 2 的"逐行 `包名: …`"会把新格式的
 * `    Package: x` 与 `    Error: …` 读成假包名 `Package` / `Error`（0.17.0 实测于
 * 0.1.7-rc.2：真实致命输出只解析出一个叫 `Package` 的包名，行 id 一个都没有）。
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

/** dsh ≥ 0.1.6 结构化启动诊断的行格式（见文件头特征 6/7）。 */
const RE_DIAG_FATAL = /startup failed: \d+ required plugins? did not activate/
const RE_DIAG_TOLERANT = /warning: \d+ entr(?:y|ies) did not activate/
const RE_SECTION_FAILED = /^\s*Failed plugins \(\d+\):\s*$/
const RE_SECTION_PENDING = /^\s*Plugins waiting for services \(\d+\):\s*$/
/** 失败条目的标题行：恰好 2 空格缩进（详情行是 4 空格起，第三列即空格，不会命中）。 */
const RE_ENTRY_LABEL = /^ {2}(\S.*?)\s*$/
/** pending 表格行：`  <行id>[ (required)]  <缺失服务>`（表格列头行由调用方先跳过）。 */
const RE_PENDING_ROW = /^ {2}(\S+?)( \(required\))? {2,}(\S.*)$/
const RE_PACKAGE_LINE = /^ {4}Package: (\S+)\s*$/
/** 宽容告警的条目行：`<行id> (<包名>): <原因>`（行 id 可含冒号，如 tty-client:web-1）。 */
const RE_TOLERANT_ROW = /^(\S+) \(([^()]+)\): (.*)$/
/** 详情行一律 4 空格起缩进（startupDiagnostic 逐行加 4 空格）。 */
const RE_DETAIL_LINE = /^ {4}\S/

/**
 * 解析失败条目的标题行：`<行id>`、`<行id> (required)`，以及防御性的 `<行id> (<包名>)`。
 * 先剥掉结尾的 required 标记再解析包名——` (...) ` 两种括号长得一样，顺序反了会把
 * 标记 `required` 当成包名。
 * @param {string} line
 * @returns {{ id: string, name: string|null, required: boolean }|null}
 */
function parseEntryLabel(line) {
  const m = RE_ENTRY_LABEL.exec(line)
  if (!m) return null
  let rest = m[1]
  let required = false
  if (rest.endsWith('(required)')) {
    required = true
    rest = rest.slice(0, -'(required)'.length).trim()
  }
  if (rest === '') return null
  const named = /^(\S+) \(([^()]+)\)$/.exec(rest)
  if (named) return { id: named[1], name: named[2], required }
  if (!/^\S+$/.test(rest)) return null
  return { id: rest, name: null, required }
}

/**
 * 解析 dsh ≥ 0.1.6 的结构化启动诊断（特征 6/7），返回条目与"已消费行号"。
 *
 * consumed 交给旧解析器跳过：新格式里 `    Package: x`、`    Error: …` 会被
 * 特征 2 的"逐行 `包名: …`"规则当成包名，产出 `Package` / `Error` 这类假命中。
 *
 * @param {string[]} lines
 * @returns {{
 *   entries: Array<{ id: string, name: string|null, required: boolean, detail: string, line: string }>,
 *   consumed: Set<number>,
 * }}
 *   entries：一条未激活条目；line 是给调用方做原因展示的合成行（包名已知时带上包名，
 *   与 names/entryIds 两个 map 用同一个字符串，matchFailures 的按行回退才能生效）。
 */
function parseStructuredDiagnostics(lines) {
  const entries = []
  const consumed = new Set()
  let i = 0
  while (i < lines.length) {
    const fatal = RE_DIAG_FATAL.test(lines[i])
    const tolerant = !fatal && RE_DIAG_TOLERANT.test(lines[i])
    if (!fatal && !tolerant) {
      i += 1
      continue
    }
    consumed.add(i)
    i += 1

    if (tolerant) {
      // 宽容告警：一行一条 `<行id> (<包名>): <原因>`，多行栈作为后续缩进行跟在后面
      while (i < lines.length) {
        const row = RE_TOLERANT_ROW.exec(lines[i])
        if (!row) break
        consumed.add(i)
        const detail = [row[3]]
        i += 1
        while (i < lines.length && /^\s+\S/.test(lines[i])) {
          consumed.add(i)
          detail.push(lines[i].trim())
          i += 1
        }
        entries.push({
          id: row[1],
          name: row[2],
          required: false,
          detail: detail.join(' '),
          line: `${row[1]} (${row[2]}): ${detail.join(' ')}`,
        })
      }
      continue
    }

    // 致命诊断：Failed plugins 小节 + Plugins waiting for services 小节
    while (i < lines.length) {
      if (lines[i].trim() === '') {
        consumed.add(i)
        i += 1
        continue
      }
      if (RE_SECTION_FAILED.test(lines[i])) {
        consumed.add(i)
        i += 1
        while (i < lines.length) {
          const label = parseEntryLabel(lines[i])
          if (!label) break
          consumed.add(i)
          const id = label.id
          const required = label.required
          let name = label.name
          i += 1
          const pkg = i < lines.length ? RE_PACKAGE_LINE.exec(lines[i]) : null
          if (pkg) {
            consumed.add(i)
            name = pkg[1]
            i += 1
          }
          const detail = []
          while (i < lines.length && RE_DETAIL_LINE.test(lines[i])) {
            consumed.add(i)
            detail.push(lines[i].trim())
            i += 1
          }
          const text = detail.join(' ')
          const head = name === null ? id : `${id} (${name})`
          entries.push({ id, name, required, detail: text, line: `${head}: ${text}` })
        }
        continue
      }
      if (RE_SECTION_PENDING.test(lines[i])) {
        consumed.add(i)
        i += 1
        if (i < lines.length) {
          // 表格列头行（Plugin / Missing services），不是条目
          consumed.add(i)
          i += 1
        }
        while (i < lines.length) {
          const row = RE_PENDING_ROW.exec(lines[i])
          if (!row) break
          consumed.add(i)
          const text = `pending (waiting for services: ${row[3].trim()})`
          entries.push({
            id: row[1],
            name: null,
            required: row[2] !== undefined,
            detail: text,
            line: `${row[1]}: ${text}`,
          })
          i += 1
        }
        continue
      }
      break
    }
  }
  return { entries, consumed }
}

/**
 * @param {string} text dsh 进程捕获到的 stderr
 * @returns {{
 *   names: Array<[string, string]>,
 *   entryIds: Array<[string, string]>,
 *   environmental: Array<[string, string]>,
 *   required: string[],
 *   inactive: Array<{ id: string, name: string|null, required: boolean, detail: string, line: string }>,
 * }}
 *   names: [包名, 出现该命中的原始行]；entryIds: [行 id, 原始行]；
 *   environmental: [条目名或行 id, 原始行]——环境类失败，调用方不得据此隔离；
 *   required: dsh 显式标注为 required 的行 id（禁用它等于启动不了，调用方必须保护）；
 *   inactive: dsh ≥ 0.1.6 结构化诊断里的未激活条目（宽容告警可能伴随退出码 0）。
 */
export function parseFailureReport(text) {
  const names = new Map()
  const entryIds = new Map()
  const environmental = new Map()
  const lines = text.split(/\r?\n/)
  const structured = parseStructuredDiagnostics(lines)
  const reEntry = new RegExp(`failed to (?:apply|import|dispose|rollback) loader entry (${ID_CLASS}) \\(([^)]+)\\)`)
  const reStackId = new RegExp(`^\\s*at \\S+#(${ID_CLASS})`)
  const reLoadList = /plugin\(s\) failed to load:\s*([^;\n]+);/
  const reDupId = new RegExp(`duplicate loader entry id: (${ID_CLASS})`)

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (structured.consumed.has(index)) continue
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

  // 结构化诊断（dsh ≥ 0.1.6）：行 id / 包名 / 详情都取自官方输出本身，
  // 不再依赖正则从自由文本里猜。names 与 entryIds 共用同一条 reason 行，
  // 供 matchFailures 在 patch 行没写 name 时按行回退取包名。
  for (const item of structured.entries) {
    if (item.name && isPluginName(item.name)) names.set(item.name, item.line)
    entryIds.set(item.id, item.line)
    if (ENV_ERRNO.test(item.line)) environmental.set(item.id, item.line)
  }

  // "did not activate" 块（dsh ≤ 0.1.5 的旧格式）：头部之后的每一行 `包名: …` 都是一条失败。
  // 失败行的错误体可能自带多行栈，所以扫到文本末尾，靠调用方的行名对照收窄。
  for (let i = 0; i < lines.length; i++) {
    if (structured.consumed.has(i)) continue
    if (!lines[i].includes('did not activate')) continue
    for (let j = i + 1; j < lines.length; j++) {
      if (structured.consumed.has(j)) continue
      const m = new RegExp(`^\\s*(${NAME_CLASS}):\\s`).exec(lines[j])
      if (!m || !isPluginName(m[1])) continue
      if (ENV_ERRNO.test(lines[j])) environmental.set(m[1], lines[j])
      else names.set(m[1], lines[j])
    }
  }

  return {
    names: [...names],
    entryIds: [...entryIds],
    environmental: [...environmental],
    required: [...new Set(structured.entries.filter((item) => item.required).map((item) => item.id))],
    inactive: structured.entries,
  }
}

/** 压缩一行错误为台账里的 reason（去空白、截断）。 */
export function summarizeLine(line, max = 160) {
  if (!line) return 'startup failure'
  const flat = line.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * 宽容告警声明的未激活条目数（`dsh: warning: N entries did not activate`）。
 *
 * 流式巡检用它判断条目是否已经收全：块可能跨多个 stderr chunk 到达，按声明数量
 * 对账才能在块完整时立刻报告，而不是等到进程退出（长驻的 `dsh web` 退出才报等于没报）。
 * @param {string} text
 * @returns {number|null} 没有该头部时返回 null
 */
export function declaredInactiveCount(text) {
  const m = /warning: (\d+) entr(?:y|ies) did not activate/.exec(text)
  return m ? Number(m[1]) : null
}
