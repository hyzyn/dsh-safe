/**
 * @hyzyn/dsh-safe — cordis.patch.yml 的行扫描与托管区块读写。
 *
 * patch 文件带用户注释与 `!!js` 表达式，不能用 YAML 库无损重写；这里只做
 * 行级扫描（拿 id/name 对照表）与"标记区块"的追加/移除，其余内容原样保留。
 * 托管区块约定与 dsh-mcp-config 的 managed 区块一致（首尾各一行标记注释）。
 */

export const MANAGED_START = '# --- dsh-safe managed (auto-generated; do not edit) ---'
export const MANAGED_END = '# --- end dsh-safe managed ---'

/**
 * 扫描 patch 文本中的 loader 行，返回 [{ id, name, disabled }]。
 *
 * 行的形状：`- id: xxx` 后跟同级缩进的 `name:` / `disabled:` 等键。需要避开
 * `config:` 子树里恰好也叫 `id`/`name` 的配置项，因此维护一个"已打开的
 * config: 键缩进"栈：处理每行前先弹出缩进 >= 当前行缩进的 config；只有栈
 * 为空时的 `- id:` 才算 loader 行。
 *
 * @param {string} text patch 文件内容
 * @returns {Array<{ id: string, name: string|null, disabled: boolean }>}
 */
export function scanPatchRows(text) {
  const rows = []
  const lines = text.split(/\r?\n/)
  const openConfigs = [] // 已打开 config: 键的缩进
  let current = null // { id, name, disabled, keyIndent }
  const flush = () => {
    if (current) {
      rows.push({ id: current.id, name: current.name, disabled: current.disabled })
      current = null
    }
  }
  for (const line of lines) {
    const indent = /^\s*/.exec(line)[0].length
    while (openConfigs.length && openConfigs[openConfigs.length - 1] >= indent) openConfigs.pop()
    if (openConfigs.length) continue // 在某个 config: 子树里
    const trimmed = line.trim()
    const rowM = /^-\s+id:\s*(\S+)$/.exec(trimmed)
    if (rowM) {
      flush()
      current = { id: rowM[1], name: null, disabled: false, keyIndent: indent + 2 }
      continue
    }
    if (!current || indent !== current.keyIndent) continue
    const nameM = /^name:\s*(.+?)\s*$/.exec(trimmed)
    if (nameM) { current.name = unquote(nameM[1]); continue }
    if (/^disabled:\s*true\s*$/.test(trimmed)) { current.disabled = true; continue }
    if (/^config:(\s|$)/.test(trimmed)) openConfigs.push(indent)
  }
  flush()
  return rows
}

function unquote(value) {
  const quoted = /^(['"])(.*?)\1(?:\s|$)/.exec(value)
  if (quoted) return quoted[2]
  return value.split(/\s+#/, 1)[0].trim()
}

/**
 * 生成托管区块文本（不含尾部换行）。
 * @param {Array<{ id: string, name?: string|null, reason?: string, quarantinedAt?: string }>} entries
 */
export function buildManagedBlock(entries) {
  const out = [MANAGED_START]
  out.push('# 由 dsh-safe 自动写入：启动失败的插件被置为 disabled，避免拖垮整个启动。')
  out.push('# 恢复：dsh-safe restore --profile <name> [--id <id> ... | --all]')
  for (const e of entries) {
    out.push(`# ${e.quarantinedAt ?? ''} · ${e.name ?? e.id} · ${e.reason ?? 'startup failure'}`.trimEnd())
    out.push(`- id: ${e.id}`)
    if (e.name) out.push(`  name: '${e.name}'`)
    out.push('  disabled: true')
  }
  out.push(MANAGED_END)
  return out.join('\n')
}

/** 去掉文本中的所有 dsh-safe 托管区块（含标记行），并规范尾部换行。 */
export function stripManagedBlocks(text) {
  const lines = text.split(/\r?\n/)
  const kept = []
  let skipping = false
  for (const line of lines) {
    if (line.trim() === MANAGED_START) { skipping = true; continue }
    if (skipping) {
      if (line.trim() === MANAGED_END) skipping = false
      continue
    }
    kept.push(line)
  }
  return kept.join('\n').replace(/\n+$/, '')
}

/**
 * 在 patch 文本上应用托管区块：先移除旧区块，再追加新区块（block 为 null 只移除）。
 *
 * 追加时若文件还是全新模板（根节点为空的 flow 序列 `[]`），必须去掉 `[]` 行，
 * 否则 `[]` 之后跟块序列是非法 YAML。
 * @returns {{ text: string }}
 */
export function applyManagedBlock(text, block) {
  let base = stripManagedBlocks(text)
  if (block) {
    base = base
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '[]')
      .join('\n')
      .replace(/\n+$/, '')
  }
  if (!block) {
    // 摘除后若文档只剩注释/空白，补回 `[]`（dsh 的 parsePatchList 拒绝 null 文档）
    const hasRows = base.split(/\r?\n/).some((l) => l.trim() && !l.trim().startsWith('#'))
    if (!hasRows) return { text: base.length ? `${base}\n[]\n` : '' }
    return { text: base + '\n' }
  }
  const next = base.length ? `${base}\n\n${block}\n` : `${block}\n`
  return { text: next }
}
