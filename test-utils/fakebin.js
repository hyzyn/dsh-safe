/**
 * @hyzyn/dsh-safe — 集成测试的跨平台 fake 可执行文件脚手架。
 *
 * 集成测试会启动真的 `bin/dsh-safe.js`，所以得先在临时 DSH_HOME 里造一个假 dsh
 * 让它去启动。造法必须分平台——因为 dsh-safe 定位并启动 dsh 的机制本身分平台：
 *
 *   - POSIX：无扩展名 + shebang + 执行位，PATH 里裸名就能跑。包目录靠 npm 那样的
 *     symlink → realpath → 向上找最近的 package.json 反推。
 *   - Windows：没有 shebang，无扩展名文件也不可执行，必须是 `.cmd`。dsh-safe 会把
 *     shim 解析成 `node <内嵌入口>`（lib/dshpaths.js 的 findShimEntry），包目录则靠
 *     shim 同级的 node_modules 反推（lib/dshpkg.js 的 resolvePackageFromShim）。
 *
 * 所以这里按**真实的 npm 全局安装布局**造，两个平台产出语义等价的目录结构：
 *
 *   <prefix>/dsh               或  <prefix>/dsh.cmd      ← PATH 里的入口
 *   <prefix>/node_modules/@deepseek-ai/dsh/package.json
 *   <prefix>/node_modules/@deepseek-ai/dsh/lib/bin.js    ← 真正被执行的脚本
 *
 * shim 与 node_modules 同级不是随意选的：resolvePackageFromShim 只反推
 * `dirname(shim)/node_modules/<pkg>` 这一条路径，而 npm 全局安装正是这个形状。
 *
 * 放在 test-utils/ 而不是 test/ 下面：`node --test` 会把 test/ 下的**任何** .js
 * 当测试文件加载（实测会让计数从 185 变 186），放进去等于多一个空的幽灵测试。
 */
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export const IS_WIN = process.platform === 'win32'

/** npm 全局 bin 的入口文件名：Windows 是 .cmd shim，其余平台是无扩展名可执行。 */
export const binName = (name, platform = process.platform) => (platform === 'win32' ? `${name}.cmd` : name)

/** 把目录前置进 PATH（必须用平台的路径分隔符——Windows 是 `;`，不是 `:`）。 */
export const withPath = (dir, base = process.env.PATH ?? '') => `${dir}${delimiter}${base}`

/**
 * 在 prefix 下造一个 fake dsh 的 npm 全局安装布局。
 *
 * @param {string} prefix 安装前缀，同时也是要放进 PATH 的目录
 * @param {{ script: string, version?: string, platform?: string }} opts
 *        script 是真正跑起来的 node 脚本；platform 只为测试注入（默认宿主平台），
 *        让 Windows 形态的布局也能在 macOS/Linux 上被断言（见 test/fakebin.test.js）
 * @returns {{ prefix: string, pkgDir: string, pkgJsonPath: string, entry: string, binPath: string }}
 */
export function installFakeDsh(prefix, { script, version = '0.1.0', platform = process.platform } = {}) {
  const pkgDir = join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
  const entry = join(pkgDir, 'lib', 'bin.js')
  const pkgJsonPath = join(pkgDir, 'package.json')
  mkdirSync(join(pkgDir, 'lib'), { recursive: true })
  writeFileSync(entry, script)
  writeFileSync(pkgJsonPath, JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' } }))

  const binPath = join(prefix, binName('dsh', platform))
  if (platform === 'win32') {
    // npm 的 .cmd shim 形状：入口路径**带引号**内嵌在 %~dp0 下。findShimEntry 的
    // 首选正则正是抓这个形状，解析出来后就改走 `node <入口>`（无 shell、无转义问题），
    // 因此这个 .cmd 本身不会被 dsh-safe 执行——它的作用只是让入口可被解析定位。
    writeFileSync(
      binPath,
      '@ECHO off\r\n' +
        '@SETLOCAL\r\n' +
        'SET "_prog=%~dp0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"\r\n' +
        'node "%_prog%" %*\r\n',
    )
  } else {
    chmodSync(entry, 0o755)
    symlinkSync(entry, binPath) // npm 全局 bin 的真实形状
  }
  return { prefix, pkgDir, pkgJsonPath, entry, binPath }
}

/**
 * 造一个 fake 包管理器（npm / pnpm）。
 *
 * 与 installFakeDsh 的关键区别：包管理器是**被直接 spawn** 的（spawnPmCapture 走
 * `shell: true`），不像 dsh 那样会被解析成 `node <入口>` 绕开 shell。所以 Windows 上
 * 它必须是一个**真能跑起来**的 .cmd，而不能只是"形状可被解析"——shim 内容会被 cmd.exe
 * 实打实地执行，并把 stdout 透回去（测试要靠它返回 dist-tags JSON）。
 *
 *   POSIX   ：<prefix>/npm       = shebang 脚本 + 执行位
 *   Windows ：<prefix>/npm.cmd   = `node "%~dp0npm.js" %*`
 *             <prefix>/npm.js    = 同一份脚本（node 会剥掉 shebang 行）
 *
 * script 需要自带 `#!/usr/bin/env node`（POSIX 靠它启动；Windows 下由 node 忽略）。
 *
 * @returns {{ binPath: string, scriptPath: string }}
 */
export function installFakePm(prefix, name, script, { platform = process.platform } = {}) {
  const binPath = join(prefix, binName(name, platform))
  if (platform === 'win32') {
    const scriptPath = join(prefix, `${name}.js`)
    writeFileSync(scriptPath, script)
    mkdirSync(prefix, { recursive: true })
    // %~dp0 自带结尾反斜杠；用 node 而非 process.execPath，与 npm 真实 shim 同形。
    // 参数只含包名/版本/dist-tag，没有 cmd 元字符，%* 直通是安全的。
    writeFileSync(binPath, `@ECHO off\r\nnode "%~dp0${name}.js" %*\r\n`)
    return { binPath, scriptPath }
  }
  writeFileSync(binPath, script)
  chmodSync(binPath, 0o755)
  return { binPath, scriptPath: binPath }
}
