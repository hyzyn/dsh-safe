import test from 'node:test'
import assert from 'node:assert/strict'
import { scanPatchRows, buildManagedBlock, stripManagedBlocks, applyManagedBlock, MANAGED_START, MANAGED_END } from '../lib/patchfile.js'

const USER_STYLE_PATCH = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries.
# 局域网远程访问（方案 A）：
- id: webserver
  config:
    host: '0.0.0.0'
    port: !!js ctx.webStartup.port ?? 3080
- id: infinite-gen-2
  disabled: true
- id: agency-agents
  disabled: true
`

const MCP_STYLE_PATCH = `# --- dsh-mcp-config managed (auto-generated; do not edit) ---
- insert:
    - id: mcp-201e5cee86
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: codegraph
        transport: stdio
        command: codegraph
        args:
          - serve
          - '--mcp'
        env: {}
        toolCallTimeoutMs: 60000
        cwd: /Users/me
# --- end dsh-mcp-config managed ---
`

test('扫描用户风格 patch：注释、!!js、disabled 均正确处理', () => {
  const rows = scanPatchRows(USER_STYLE_PATCH)
  assert.deepEqual(rows, [
    { id: 'webserver', name: null, disabled: false },
    { id: 'infinite-gen-2', name: null, disabled: true },
    { id: 'agency-agents', name: null, disabled: true },
  ])
})

test('扫描 insert 区块：config 子树里的列表项与键不会被当成行', () => {
  const rows = scanPatchRows(MCP_STYLE_PATCH)
  assert.deepEqual(rows, [
    { id: 'mcp-201e5cee86', name: '@deepseek-ai/dsh-mcp-client', disabled: false },
  ])
})

test('config 内嵌 id/name 列表不会被当成 loader 行', () => {
  const text = `- id: outer
  name: '@acme/outer'
  config:
    servers:
      - id: inner
        name: 'not-a-package-row'
      - id: inner2
- id: next
  name: '@acme/next'
`
  const rows = scanPatchRows(text)
  assert.deepEqual(rows, [
    { id: 'outer', name: '@acme/outer', disabled: false },
    { id: 'next', name: '@acme/next', disabled: false },
  ])
})

test('托管区块：生成、追加、幂等、摘除', () => {
  const block = buildManagedBlock([
    { id: 'badplug', name: '@acme/broken', reason: 'failed to load', quarantinedAt: '2026-09-05T00:00:00.000Z' },
  ])
  assert.ok(block.startsWith(MANAGED_START))
  assert.ok(block.endsWith(MANAGED_END))
  assert.ok(block.includes("- id: badplug"))
  assert.ok(block.includes("  name: '@acme/broken'"))
  assert.ok(block.includes('  disabled: true'))

  const once = applyManagedBlock(USER_STYLE_PATCH, block).text
  assert.ok(once.includes(MANAGED_START))
  assert.ok(once.trimEnd().endsWith(MANAGED_END))
  assert.ok(once.includes('- id: webserver')) // 用户内容保留

  const twice = applyManagedBlock(once, block).text
  assert.equal(twice, once) // 幂等

  const stripped = stripManagedBlocks(once)
  assert.ok(!stripped.includes(MANAGED_START))
  assert.ok(stripped.includes('- id: webserver'))
  assert.equal(stripManagedBlocks(USER_STYLE_PATCH) + '\n', USER_STYLE_PATCH.replace(/\n+$/, '') + '\n')
})

test('托管区块：全新模板（根节点 []）追加后仍是合法 YAML 块序列', () => {
  const template = '# Your patch layer for this dsh profile, applied after every bundle layer:\n[]\n'
  const block = buildManagedBlock([{ id: 'broken', name: '@acme/x', quarantinedAt: 't', reason: 'r' }])
  const { text } = applyManagedBlock(template, block)
  assert.ok(!text.includes('[]'))
  assert.ok(text.includes(MANAGED_START))
  // 头部注释保留
  assert.ok(text.startsWith('# Your patch layer'))
  // 摘除后文档只剩注释 → 补回 []，保持 dsh 可解析
  const restored = applyManagedBlock(text, null).text
  assert.ok(!restored.includes(MANAGED_START))
  assert.ok(restored.startsWith('# Your patch layer'))
  assert.ok(restored.trimEnd().endsWith('[]'))
})

test('托管区块：无 name 的行只写 id + disabled', () => {
  const block = buildManagedBlock([{ id: 'bare', quarantinedAt: 't', reason: 'r' }])
  assert.ok(block.includes('- id: bare'))
  assert.ok(!block.includes("name:"))
})
