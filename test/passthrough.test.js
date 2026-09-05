import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BIN = join(ROOT, 'bin', 'dsh-safe.js')

/** 假 dsh：只记录收到的 argv 并退出 0，用于断言透传。 */
function makeFixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-safe-passthrough-'))
  const binDir = join(home, 'bin')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  const dshBin = join(binDir, 'dsh')
  writeFileSync(
    dshBin,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.FAKE_DSH_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n')
process.exit(0)
`,
  )
  chmodSync(dshBin, 0o755)
  return { home, binDir }
}

function runSafe(fx, args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_HOME: fx.home,
      PATH: `${fx.binDir}:${process.env.PATH}`,
      DSH_SAFE_LANG: 'zh',
      FAKE_DSH_CALLS: join(fx.home, 'calls'),
    },
  })
}

const calls = (fx) =>
  readFileSync(join(fx.home, 'calls'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

const cleanup = (home) => rmSync(home, { recursive: true, force: true })

test('透传：位置参数之后的旗标原样转发（含 dsh-safe 同名旗标）', () => {
  const fx = makeFixture()
  try {
    const result = runSafe(fx, ['web', '--port', '3000', '--dry-run'])
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    assert.deepEqual(calls(fx), [['web', '--port', '3000', '--dry-run']])
  } finally {
    cleanup(fx.home)
  }
})

test('透传：launcher 旗标连值转发（--profile / 重复 --patch）', () => {
  const fx = makeFixture()
  try {
    const result = runSafe(fx, ['--profile', 'tui', '--patch', './a.yml', '--patch', './b.yml', 'web'])
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    assert.deepEqual(calls(fx), [['--profile', 'tui', '--patch', './a.yml', '--patch', './b.yml', 'web']])
  } finally {
    cleanup(fx.home)
  }
})

test('透传：dsh-safe 自留旗标在 launcher 位置被剥离，不转发', () => {
  const fx = makeFixture()
  try {
    const result = runSafe(fx, ['--dry-run', '--allow-first-party', '--max-retries=1', 'web'])
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    assert.deepEqual(calls(fx), [['web']])
  } finally {
    cleanup(fx.home)
  }
})

test('透传：-- 分隔符之后原样转发', () => {
  const fx = makeFixture()
  try {
    const result = runSafe(fx, ['--', 'web', '--dry-run'])
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    assert.deepEqual(calls(fx), [['--', 'web', '--dry-run']])
  } finally {
    cleanup(fx.home)
  }
})

test('透传：含空格 / 中文 / 空串的参数逐个保留', () => {
  const fx = makeFixture()
  try {
    const result = runSafe(fx, ['web', 'hello world', '中文', ''])
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    assert.deepEqual(calls(fx), [['web', 'hello world', '中文', '']])
  } finally {
    cleanup(fx.home)
  }
})

test('透传：plugin 子命令整体转发（pnpm 模式）', () => {
  const fx = makeFixture()
  try {
    const result = runSafe(fx, ['plugin', 'list', '--registry', 'http://localhost:4873'])
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    assert.deepEqual(calls(fx), [['plugin', 'list', '--registry', 'http://localhost:4873']])
  } finally {
    cleanup(fx.home)
  }
})

test('透传：launcher 位置的未知旗标不拦截，原样转发', () => {
  const fx = makeFixture()
  try {
    const result = runSafe(fx, ['--dump-config'])
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
    assert.deepEqual(calls(fx), [['--dump-config']])
  } finally {
    cleanup(fx.home)
  }
})
