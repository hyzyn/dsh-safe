import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePackageFromShim } from '../lib/update.js'

const cleanup = (dir) => rmSync(dir, { recursive: true, force: true })

/**
 * Windows 上 npm/pnpm 的全局 bin 是脚本拷贝而非 symlink，无法 realpath 解析；
 * resolvePackageFromShim 靠 shim 内容里内嵌的 node_modules 入口路径定位包。
 * 这里在任意平台直接测解析逻辑（纯文件/字符串操作）。
 */
test('shim 解析：npm 的 cmd shim（Windows 布局）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-safe-shim-'))
  try {
    const pkgDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.2-rc.1' }))
    const shim = join(dir, 'dsh.cmd')
    writeFileSync(
      shim,
      '@ECHO off\r\n' +
        'IF EXIST "%~dp0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" (\r\n' +
        '  SET "_prog=%~dp0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"\r\n' +
        ')\r\n' +
        'node "%_prog%" %*\r\n',
    )
    const resolved = resolvePackageFromShim(shim)
    assert.equal(resolved.name, '@deepseek-ai/dsh')
    assert.equal(resolved.version, '0.1.2-rc.1')
    assert.equal(resolved.pkgDir, pkgDir)
  } finally {
    cleanup(dir)
  }
})

test('shim 解析：sh shim（npm 的 POSIX 脚本形态）与非包内容返回 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-safe-shim-'))
  try {
    const pkgDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0' }))
    const shim = join(dir, 'dsh')
    writeFileSync(
      shim,
      '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\n' +
        '"$basedir/node" "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"\n',
    )
    const resolved = resolvePackageFromShim(shim)
    assert.equal(resolved.name, '@deepseek-ai/dsh')
    assert.equal(resolved.version, '0.1.0')

    // 内容里没有 node_modules 入口 → null
    const notAShim = join(dir, 'other')
    writeFileSync(notAShim, 'just a plain file\n')
    assert.equal(resolvePackageFromShim(notAShim), null)
    assert.equal(resolvePackageFromShim(join(dir, 'missing')), null)
  } finally {
    cleanup(dir)
  }
})
