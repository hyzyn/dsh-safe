import test from 'node:test'
import assert from 'node:assert/strict'
import { detectInvocation } from '../lib/dshpaths.js'

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
