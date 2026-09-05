import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { detectInvocation, resolveDshSpawnTarget } from '../lib/dshpaths.js'

test('web 别名 → profile web', () => {
  assert.deepEqual(detectInvocation(['web']), { mode: 'boot', profile: 'web' })
})

test('--profile 旗标（空格与等号形式）', () => {
  assert.deepEqual(detectInvocation(['--profile', 'tui', '--resume', 'x']), { mode: 'boot', profile: 'tui' })
  assert.deepEqual(detectInvocation(['--profile=tui']), { mode: 'boot', profile: 'tui' })
})

test('--patch 的值不会被当成位置参数', () => {
  assert.deepEqual(detectInvocation(['--patch', 'a.yml', 'web']), { mode: 'boot', profile: 'web' })
})

test('--patch 的等号形式是自包含旗标，不吞后面的位置参数', () => {
  assert.deepEqual(detectInvocation(['--patch=./a.yml', 'web']), { mode: 'boot', profile: 'web' })
  assert.deepEqual(detectInvocation(['--profile=tui', '--patch=./a.yml', 'web']), {
    mode: 'boot',
    profile: 'tui',
  })
})

test('--profile 重复出现时后者生效；值缺失时安全返回 null', () => {
  assert.deepEqual(detectInvocation(['--profile', 'tui', '--profile', 'web']), { mode: 'boot', profile: 'web' })
  assert.deepEqual(detectInvocation(['--profile']), { mode: 'boot', profile: null })
})

test('内部参数里的 --profile 不影响 launcher 识别', () => {
  // 第一个位置参数 web 之后全是内部参数
  assert.deepEqual(detectInvocation(['web', 'resume', '--profile', 'x']), { mode: 'boot', profile: 'web' })
})

test('plugin 子命令的 --profile 跟在子命令后', () => {
  assert.deepEqual(detectInvocation(['plugin', '--profile', 'tui', 'add', 'pkg']), { mode: 'plugin', profile: 'tui' })
})

test('既无 --profile 也无已知别名且目录不存在 → null', () => {
  assert.deepEqual(detectInvocation(['--resume', 'x']), { mode: 'boot', profile: null })
  assert.deepEqual(detectInvocation(['no-such-profile-xyz']), { mode: 'boot', profile: null })
})

// ---------- resolveDshSpawnTarget（Windows 兼容） ----------

/** 搭一个假的 dsh 全局安装布局：bin 目录 + node_modules 入口脚本。 */
function makeSpawnFixture(extraBinDir) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-safe-spawn-'))
  const entryDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(entryDir, { recursive: true })
  const entry = join(entryDir, 'bin.js')
  writeFileSync(entry, 'process.stdout.write("dsh ok\\n")\n')
  const binDir = extraBinDir ?? dir
  mkdirSync(binDir, { recursive: true })
  return {
    dir,
    binDir,
    entry,
    npmCmdShim: join(binDir, 'dsh.cmd'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

// npm 标准格式：入口直接内嵌在调用行
const NPM_SHIM =
  '@ECHO off\r\n' +
  '@SETLOCAL\r\n' +
  '@IF EXIST "%~dp0\\node.exe" (\r\n' +
  '  SET "_prog=%~dp0\\node.exe"\r\n' +
  ') ELSE (\r\n' +
  '  SET "_prog=node"\r\n' +
  ')\r\n' +
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & if defined _prog (\r\n' +
  '  "%_prog%"  "%~dp0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n' +
  ') else (\r\n' +
  '  "%_prog%"  "%~dp0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n' +
  ')\r\n'

// 变体格式：入口先 SET 进变量，再 node "%_prog%"
const NPM_SHIM_SETVAR =
  '@ECHO off\r\n' +
  'IF EXIST "%~dp0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" (\r\n' +
  '  SET "_prog=%~dp0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"\r\n' +
  ')\r\n' +
  'node "%_prog%" %*\r\n'

test('spawn 目标：非 Windows 原样返回', () => {
  assert.deepEqual(resolveDshSpawnTarget('dsh', { platform: 'linux', pathEnv: '' }), {
    file: 'dsh',
    prefix: [],
    shell: false,
  })
})

test('spawn 目标：cmd shim 内嵌入口 → 改为 node 入口直接启动', () => {
  const fx = makeSpawnFixture()
  try {
    writeFileSync(fx.npmCmdShim, NPM_SHIM)
    const target = resolveDshSpawnTarget('dsh', {
      platform: 'win32',
      pathEnv: `${fx.binDir};C:\\Windows\\System32`,
      execPath: '/usr/bin/node',
    })
    assert.deepEqual(target, { file: '/usr/bin/node', prefix: [fx.entry], shell: false })
  } finally {
    fx.cleanup()
  }
})

test('spawn 目标：SET 变量格式的 shim 同样解析', () => {
  const fx = makeSpawnFixture()
  try {
    writeFileSync(fx.npmCmdShim, NPM_SHIM_SETVAR)
    const target = resolveDshSpawnTarget('dsh', {
      platform: 'win32',
      pathEnv: fx.binDir,
      execPath: '/usr/bin/node',
    })
    assert.deepEqual(target, { file: '/usr/bin/node', prefix: [fx.entry], shell: false })
  } finally {
    fx.cleanup()
  }
})

test('spawn 目标：ps1 shim（$basedir 形式）也能解析', () => {
  const fx = makeSpawnFixture()
  try {
    writeFileSync(join(fx.binDir, 'dsh.ps1'), '$ret = & $exe $basedir/node_modules/@deepseek-ai/dsh/lib/bin.js $args\n')
    const target = resolveDshSpawnTarget('dsh', {
      platform: 'win32',
      pathEnv: fx.binDir,
      execPath: '/usr/bin/node',
    })
    assert.deepEqual(target, { file: '/usr/bin/node', prefix: [fx.entry], shell: false })
  } finally {
    fx.cleanup()
  }
})

test('spawn 目标：.exe 直接运行，不解析 shim', () => {
  const fx = makeSpawnFixture()
  try {
    const exe = join(fx.binDir, 'dsh.exe')
    writeFileSync(exe, 'MZ binary')
    const target = resolveDshSpawnTarget('dsh', { platform: 'win32', pathEnv: fx.binDir })
    assert.deepEqual(target, { file: exe, prefix: [], shell: false })
  } finally {
    fx.cleanup()
  }
})

test('spawn 目标：PATH 目录顺序优先于扩展名', () => {
  const dirA = mkdtempSync(join(tmpdir(), 'dsh-safe-spawn-a-'))
  const dirB = mkdtempSync(join(tmpdir(), 'dsh-safe-spawn-b-'))
  try {
    const entryA = join(dirA, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    mkdirSync(dirname(entryA), { recursive: true })
    writeFileSync(entryA, 'ok\n')
    writeFileSync(join(dirA, 'dsh.cmd'), NPM_SHIM_SETVAR)
    const exeB = join(dirB, 'dsh.exe')
    writeFileSync(exeB, 'MZ binary')
    const target = resolveDshSpawnTarget('dsh', {
      platform: 'win32',
      pathEnv: `${dirA};${dirB}`,
      execPath: '/usr/bin/node',
    })
    // dirA 在前 → 用 dirA 的 cmd shim（与 cmd.exe 的解析顺序一致）
    assert.deepEqual(target, { file: '/usr/bin/node', prefix: [entryA], shell: false })
    // dirB 在前 → dirB 的 exe
    const target2 = resolveDshSpawnTarget('dsh', { platform: 'win32', pathEnv: `${dirB};${dirA}` })
    assert.deepEqual(target2, { file: exeB, prefix: [], shell: false })
  } finally {
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
})

test('spawn 目标：shim 里解析不出入口 → shell 方式兜底', () => {
  const fx = makeSpawnFixture()
  try {
    writeFileSync(fx.npmCmdShim, '@ECHO off\r\nrem no entry here\r\n')
    const target = resolveDshSpawnTarget('dsh', { platform: 'win32', pathEnv: fx.binDir })
    assert.deepEqual(target, { file: fx.npmCmdShim, prefix: [], shell: true })
  } finally {
    fx.cleanup()
  }
})

test('spawn 目标：入口文件不存在 → shell 方式兜底', () => {
  const fx = makeSpawnFixture()
  try {
    writeFileSync(fx.npmCmdShim, NPM_SHIM)
    rmSync(fx.entry)
    const target = resolveDshSpawnTarget('dsh', { platform: 'win32', pathEnv: fx.binDir })
    assert.deepEqual(target, { file: fx.npmCmdShim, prefix: [], shell: true })
  } finally {
    fx.cleanup()
  }
})

test('spawn 目标：PATH 上没有任何候选 → 原样返回（报错行为不变）', () => {
  assert.deepEqual(resolveDshSpawnTarget('dsh', { platform: 'win32', pathEnv: 'C:\\nowhere' }), {
    file: 'dsh',
    prefix: [],
    shell: false,
  })
})

test('spawn 目标：shell 兜底时含空白的路径加引号', () => {
  const fx = makeSpawnFixture(join(tmpdir(), 'my shims'))
  try {
    writeFileSync(fx.npmCmdShim, '@ECHO off\r\nrem no entry\r\n')
    const target = resolveDshSpawnTarget('dsh', { platform: 'win32', pathEnv: fx.binDir })
    assert.equal(target.shell, true)
    assert.equal(target.file, `"${fx.npmCmdShim}"`)
  } finally {
    fx.cleanup()
  }
})
