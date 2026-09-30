import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quoteShellArg } from '../lib/dshpaths.js'
import { spawnPmCapture, spawnPmInherit } from '../lib/dshpkg.js'

/**
 * 包管理器 spawn 的 Windows 引号化回归测试（issue #1）。
 *
 * `shell: true` 时 Node 只把整条命令行用一对引号包给 cmd.exe，cmd 的 /s 又把它剥掉，
 * 于是 `C:\Program Files\nodejs\npm.cmd` 被切成 `C:\Program` —— 因为
 * `C:\Program Files\nodejs` 是 Node.js Windows 官方安装器的默认位置，用默认方式安装的
 * 用户全都会踩到：update --check 拿不到版本、--to 安装直接报「不是内部或外部命令」、
 * `-u` 退化成跳过检查后启动。
 *
 * 这里用注入的 spawn 断言"传给 cmd 的 file 到底长什么样"（跨平台可跑），
 * 再用 Windows-only 的端到端用例证明修好的命令行真能被 cmd.exe 执行。
 */

/** 记录调用的假 spawn，替代 node:child_process 的 spawnSync。 */
function spy() {
  const calls = []
  const spawn = (file, args, options) => {
    calls.push({ file, args, options })
    return { status: 0, stdout: '{}', stderr: '' }
  }
  return { calls, spawn }
}

const WIN_NPM = 'C:\\Program Files\\nodejs\\npm.cmd'
const WIN_PNPM = 'C:\\Users\\me\\AppData\\Local\\pnpm\\pnpm.cmd'

test('quoteShellArg：含空白才加引号，已有的引号不重复加', () => {
  assert.equal(quoteShellArg(WIN_NPM), `"${WIN_NPM}"`)
  assert.equal(quoteShellArg('C:\\Program Files'), '"C:\\Program Files"')
  assert.equal(quoteShellArg('/opt/homebrew/bin/npm'), '/opt/homebrew/bin/npm')
  assert.equal(quoteShellArg('npm'), 'npm')
  // 幂等：已引号化过的不再包一层（否则会变成 ""a b""）
  assert.equal(quoteShellArg('"C:\\Program Files"'), '"C:\\Program Files"')
})

test('spawnPmCapture：Windows 上含空白的 bin 加引号并走 shell', () => {
  const { calls, spawn } = spy()
  spawnPmCapture(WIN_NPM, ['view', '@deepseek-ai/dsh', 'dist-tags', '--json'], {
    spawn,
    platform: 'win32',
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, `"${WIN_NPM}"`)
  assert.equal(calls[0].options.shell, true)
  assert.equal(calls[0].options.encoding, 'utf8')
  // args 由调用方保证无空白（包名 + ^[\w.+-]+$ 校验），必须原样传递
  assert.deepEqual(calls[0].args, ['view', '@deepseek-ai/dsh', 'dist-tags', '--json'])
})

test('spawnPmCapture：Windows 上无空白的 bin 保持原样（不改变既有行为）', () => {
  const { calls, spawn } = spy()
  spawnPmCapture(WIN_PNPM, ['root', '-g'], { spawn, platform: 'win32' })
  assert.equal(calls[0].file, WIN_PNPM)
  assert.equal(calls[0].options.shell, true)
})

test('spawnPmCapture：find 不到 bin 时的裸名回退不受影响', () => {
  const { calls, spawn } = spy()
  spawnPmCapture('npm', ['view', 'x', 'dist-tags', '--json'], { spawn, platform: 'win32' })
  assert.equal(calls[0].file, 'npm')
})

test('spawnPmCapture：非 Windows 原样传递且不加 shell', () => {
  const { calls, spawn } = spy()
  spawnPmCapture('/opt/homebrew/bin/npm', ['view', 'x'], { spawn, platform: 'darwin' })
  assert.equal(calls[0].file, '/opt/homebrew/bin/npm')
  assert.equal(calls[0].options.shell, undefined)
})

test('spawnPmInherit：Windows 上同样引号化并透传 stdio', () => {
  const { calls, spawn } = spy()
  spawnPmInherit(WIN_NPM, ['install', '-g', '@deepseek-ai/dsh@0.2.0'], { spawn, platform: 'win32' })
  assert.equal(calls[0].file, `"${WIN_NPM}"`)
  assert.equal(calls[0].options.shell, true)
  assert.equal(calls[0].options.stdio, 'inherit')
})

test('spawnPmInherit：非 Windows 原样传递且不加 shell', () => {
  const { calls, spawn } = spy()
  spawnPmInherit('/usr/bin/npm', ['install', '-g', 'x'], { spawn, platform: 'linux' })
  assert.equal(calls[0].file, '/usr/bin/npm')
  assert.equal(calls[0].options.shell, undefined)
  assert.equal(calls[0].options.stdio, 'inherit')
})

/**
 * 端到端：真的建一个含空格的目录 + 真的 .cmd，交给真的 cmd.exe 跑。
 * 这是唯一能证明"加引号后 cmd /s 确实按预期解析"的用例——纯断言 file 字符串
 * 无法覆盖 cmd 的 /s 语义。仅 Windows 运行。
 */
test('Windows 端到端：含空格的 .cmd 能被真正执行', { skip: process.platform !== 'win32' }, () => {
  // mkdtemp 的模板自带空格：...\Temp\dsh-safe pm-XXXXXX
  const dir = mkdtempSync(join(tmpdir(), 'dsh-safe pm-'))
  try {
    assert.match(dir, / /) // 前提取不到空格就白测了
    const pm = join(dir, 'fakepm.cmd')
    writeFileSync(pm, '@ECHO OFF\r\necho {"latest":"1.2.3"}\r\n')

    const { status, stdout, stderr } = spawnPmCapture(pm, ['view', 'x', 'dist-tags', '--json'])
    assert.equal(status, 0, `cmd 执行失败：${stderr}`)
    assert.deepEqual(JSON.parse(stdout), { latest: '1.2.3' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 端到端（install 路径）：透传 stdio 的分支同样要能跑起来。 */
test('Windows 端到端：含空格的 .cmd 经 spawnPmInherit 执行', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-safe pm-'))
  try {
    const pm = join(dir, 'fakeinstall.cmd')
    writeFileSync(pm, '@ECHO OFF\r\nexit /b 0\r\n')
    const { status } = spawnPmInherit(pm, ['install', '-g', 'x'])
    assert.equal(status, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
