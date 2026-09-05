import test from 'node:test'
import assert from 'node:assert/strict'
import { detectLocale, translate } from '../lib/i18n.js'

test('i18n：环境变量优先级与 zh 判定', () => {
  assert.equal(detectLocale({ LC_ALL: 'zh_CN.UTF-8' }, 'en-US'), 'zh')
  assert.equal(detectLocale({ LANG: 'en_US.UTF-8' }, 'zh-CN'), 'en')
  assert.equal(detectLocale({ LANGUAGE: 'zh_CN:en_US' }, 'en-US'), 'zh')
  assert.equal(detectLocale({ DSH_SAFE_LANG: 'zh', LC_ALL: 'en_US.UTF-8' }, 'en-US'), 'zh')
  assert.equal(detectLocale({ DSH_SAFE_LANG: 'en', LC_ALL: 'zh_CN.UTF-8' }, 'en-US'), 'en')
  assert.equal(detectLocale({ LC_ALL: 'C', LANG: 'zh_CN.UTF-8' }, 'en-US'), 'zh') // C/POSIX 回落到下一优先级
  assert.equal(detectLocale({ LANG: 'fr_FR.UTF-8' }, 'zh-CN'), 'en') // 非 zh 一律英文
})

test('i18n：全部未设置时退回 Intl 默认 locale', () => {
  assert.equal(detectLocale({}, 'zh-CN'), 'zh')
  assert.equal(detectLocale({}, 'en-US'), 'en')
  assert.equal(detectLocale({ LANG: '' }, 'en-US'), 'en')
})

test('i18n：词条插值与缺失回落', () => {
  assert.equal(translate('zh', 'disabled'), '已禁用')
  assert.equal(translate('en', 'disabled'), 'disabled')
  assert.equal(
    translate('en', 'stillQuarantined', { profile: 'web', count: 2 }),
    '[dsh-safe] web still has 2 quarantined row(s); restart dsh to apply.',
  )
  assert.equal(translate('zh', 'no-such-key'), 'no-such-key')
})
