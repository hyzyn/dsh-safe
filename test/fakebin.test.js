import test from 'node:test'
import assert from 'node:assert/strict'
import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { installFakeDsh, installFakePm, withPath } from '../test-utils/fakebin.js'
import { resolveDshSpawnTarget } from '../lib/dshpaths.js'
import { resolvePackageFromShim, spawnPmCapture } from '../lib/dshpkg.js'

/**
 * fixture 脚手架的自校验。
 *
 * 存在的理由：test-utils/fakebin.js 是**按平台**造布局的，而它的正确性判据是
 * "dsh-safe 能不能解析出这个布局"——只有真机跑集成测试才知道。CI 里的 macos/ubuntu
 * 只覆盖 POSIX 那一半，Windows 那一半要等 windows-latest 跑起来。
 *
 * 这里用 platform 注入把 Windows 形态的布局也造在 macos/ubuntu 上，直接喂给
 * dsh-safe 的解析函数断言。等于把"Windows fixture 设计是否正确"这件事提前到
 * 任何平台都能验证，不必等 Windows CI。
 */

const cleanup = (dir) => rmSync(dir, { recursive: true, force: true })

test('fakebin：POSIX 形态是 symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-safe-fb-posix-'))
  try {
    const { binPath } = installFakeDsh(dir, { script: 'process.exit(0)\n', platform: 'linux' })
    assert.equal(basename(binPath), 'dsh')
    assert.ok(lstatSync(binPath).isSymbolicLink()) // 注意 lstat：stat 会跟随链接
  } finally {
    cleanup(dir)
  }
})

/**
 * 执行位只在 POSIX 上有意义：Windows 没有权限位，chmodSync 只切只读标志，
 * 因此 `mode & 0o111` 恒为 0。
 *
 * 这条是首次 windows job 真机跑出来的：当时一并断言的 symlink 在 runner 上**成功**
 * 了（runner 有权限），失败的只有执行位。Windows 形态本来就不走 symlink + 执行位
 * 这条路（它用 .cmd shim），所以这里按平台跳过而不是放宽断言——放宽会让 POSIX 上
 * "忘记 chmod 导致 shebang 起不来"这类回归失去守卫。
 */
test('fakebin：POSIX 形态的入口有执行位', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-safe-fb-posix-'))
  try {
    const { entry } = installFakeDsh(dir, { script: 'process.exit(0)\n', platform: 'linux' })
    assert.ok(statSync(entry).mode & 0o111) // 没有执行位，shebang 起不来
  } finally {
    cleanup(dir)
  }
})

test('fakebin：Windows 形态是 dsh.cmd shim（不是无扩展名文件）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-safe-fb-win-'))
  try {
    const { binPath } = installFakeDsh(dir, { script: 'process.exit(0)\n', platform: 'win32' })
    assert.equal(basename(binPath), 'dsh.cmd')
  } finally {
    cleanup(dir)
  }
})

test('fakebin：Windows 形态能被 resolveDshSpawnTarget 解析成 node + 入口', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-safe-fb-win-'))
  try {
    const { entry } = installFakeDsh(dir, { script: 'process.exit(0)\n', platform: 'win32' })
    // 真实场景里 pathEnv 是 `;` 分隔的；这里单元素足够，且 Windows 上 split(';') 不受影响
    const target = resolveDshSpawnTarget('dsh', {
      platform: 'win32',
      pathEnv: dir,
      execPath: '/fake/node',
    })
    // 解析不出入口就会退回 { file: 'dsh', ... }（裸名 → Windows 上 ENOENT），
    // 所以这条断言正是"fixture 在 Windows 上能不能跑"的判据
    assert.deepEqual(target, { file: '/fake/node', prefix: [entry], shell: false })
  } finally {
    cleanup(dir)
  }
})

test('fakebin：Windows 形态能被 resolvePackageFromShim 反推出包目录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-safe-fb-win-'))
  try {
    const { binPath, pkgDir } = installFakeDsh(dir, {
      script: 'process.exit(0)\n',
      version: '0.1.2-rc.1',
      platform: 'win32',
    })
    // 这条覆盖的是"没有 dsh 安装目录时的包名/版本来源"：resolvePackageFromShim
    // 只能反推 dirname(shim)/node_modules/<pkg>，所以 shim 必须与 node_modules 同级
    assert.deepEqual(resolvePackageFromShim(binPath), {
      name: '@deepseek-ai/dsh',
      version: '0.1.2-rc.1',
      pkgDir,
    })
  } finally {
    cleanup(dir)
  }
})

test('fakebin：withPath 用的是平台分隔符而不是写死的冒号', () => {
  // 原集成测试写死 `:`，Windows（分隔符是 `;`）下整条 PATH 会被当成一个目录项，
  // 假 bin 永远找不到——这正是移植要修掉的第一号断点。
  assert.equal(withPath('A', 'B'), `A${delimiter}B`)
  assert.equal(withPath('A'), `A${delimiter}${process.env.PATH}`)
})

// ---------- fake 包管理器 ----------

const PM_SCRIPT = '#!/usr/bin/env node\nconsole.log(JSON.stringify({ latest: "1.2.3" }))\n'

/**
 * 与 dsh 形态的关键差异：包管理器是**被直接 spawn** 的（spawnPmCapture 走 shell:true），
 * 不像 dsh 会被 findShimEntry 解析成 `node <入口>` 绕开 shell。所以 Windows 上它必须是
 * 真能执行的 .cmd，而"形状可被解析"是不够的——这条走真实 spawnPmCapture 调用路径验证。
 *
 * 仅 POSIX：这条强制造 POSIX 形态（无扩展名 + shebang），再交给 spawnPmCapture 执行。
 * 在 Windows 上两者矛盾——spawnPmCapture 会按宿主平台走 cmd.exe，cmd 执行不了无扩展名
 * 文件。这个组合在真实场景里不存在（Windows 上 installFakePm 默认就产 npm.cmd），
 * 硬在 Windows 上跑等于用矛盾的前提去测一个不会发生的形态。
 * Windows 那一半由 .cmd+.js 形状断言与真实跑 update/integration 的用例覆盖。
 */
test('fakebin：POSIX 形态的 fake 包管理器能经 spawnPmCapture 真跑起来', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-safe-fb-pm-'))
  try {
    const { binPath } = installFakePm(dir, 'npm', PM_SCRIPT, { platform: 'linux' })
    assert.equal(basename(binPath), 'npm')
    const { status, stdout } = spawnPmCapture(binPath, ['view', 'x', 'dist-tags', '--json'])
    assert.equal(status, 0)
    assert.deepEqual(JSON.parse(stdout), { latest: '1.2.3' })
  } finally {
    cleanup(dir)
  }
})

test('fakebin：Windows 形态的 fake 包管理器是 .cmd + 脚本两件套', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-safe-fb-pm-'))
  try {
    const { binPath, scriptPath } = installFakePm(dir, 'npm', PM_SCRIPT, { platform: 'win32' })
    // 文件名必须是 whichCmd('npm') 的候选之一（npm.cmd / npm.exe / npm.ps1 / npm），
    // 否则 dsh-safe 在 Windows 上根本找不到这个假包管理器
    assert.equal(basename(binPath), 'npm.cmd')
    // .cmd 由 cmd.exe 实打实执行：必须用 node 把参数转发给脚本，而不是仅供解析的形状
    assert.match(readFileSync(binPath, 'utf8'), /node "%~dp0npm\.js" %\*/)
    assert.equal(readFileSync(scriptPath, 'utf8'), PM_SCRIPT)
  } finally {
    cleanup(dir)
  }
})

test('fakebin：Windows 形态的包管理器 shim 与 dsh shim 形状不同（前者会被执行）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-safe-fb-pm-'))
  try {
    const dsh = installFakeDsh(dir, { script: 'process.exit(0)\n', platform: 'win32' })
    const pm = installFakePm(dir, 'npm', PM_SCRIPT, { platform: 'win32' })
    const dshShim = readFileSync(dsh.binPath, 'utf8')
    const pmShim = readFileSync(pm.binPath, 'utf8')
    // dsh 的 shim 走 SET _prog 的 npm 形状，被解析后即弃用；npm 的 shim 是直接调用
    assert.match(dshShim, /SET "_prog=/)
    assert.doesNotMatch(pmShim, /SET "_prog=/)
  } finally {
    cleanup(dir)
  }
})
