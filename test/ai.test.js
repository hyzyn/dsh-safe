import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'

process.env.DSH_SAFE_LANG = 'zh' // 本文件的断言固定中文（测试文件独立进程运行）

const { aiEnabled, redact, explainFailure, detectFailureWithAI } = await import('../lib/ai.js')

const originalFetch = globalThis.fetch
const originalKey = process.env.DSH_SAFE_AI_KEY
test.after(() => {
  globalThis.fetch = originalFetch
  if (originalKey === undefined) delete process.env.DSH_SAFE_AI_KEY
  else process.env.DSH_SAFE_AI_KEY = originalKey
})

/** 替换全局 fetch，记录调用并按次数响应。 */
function stubFetch(respond) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return respond(calls.length)
  }
  return calls
}
const okResponse = (content) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) })

test('aiEnabled：有 key 才启用', () => {
  process.env.DSH_SAFE_AI_KEY = 'test-key'
  assert.equal(aiEnabled(), true)
  delete process.env.DSH_SAFE_AI_KEY
  assert.equal(aiEnabled(), false)
})

test('redact：home 路径脱敏为 ~', () => {
  assert.equal(redact(`${homedir()}/.dsh/profiles/web/cordis.patch.yml`), '~/.dsh/profiles/web/cordis.patch.yml')
})

test('explainFailure：请求默认指向 DeepSeek，模型与脱敏正确', async () => {
  process.env.DSH_SAFE_AI_KEY = 'test-key'
  const calls = stubFetch(() => okResponse('原因：坏插件'))
  const out = await explainFailure(`boom at ${homedir()}/x\n`)
  assert.equal(out, '原因：坏插件')
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions')
  assert.equal(calls[0].body.model, 'deepseek-chat')
  assert.equal(calls[0].body.stream, false)
  assert.ok(!JSON.stringify(calls[0].body).includes(homedir()), 'home 路径必须脱敏')
  assert.ok(JSON.stringify(calls[0].body).includes('~/x'))
})

test('explainFailure：无 key → null 且不发请求', async () => {
  delete process.env.DSH_SAFE_AI_KEY
  const calls = stubFetch(() => okResponse('x'))
  assert.equal(await explainFailure('y'), null)
  assert.equal(calls.length, 0)
})

test('explainFailure：HTTP 非 2xx / fetch 抛错 → null', async () => {
  process.env.DSH_SAFE_AI_KEY = 'test-key'
  stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }))
  assert.equal(await explainFailure('a'), null)
  globalThis.fetch = async () => {
    throw new Error('network down')
  }
  assert.equal(await explainFailure('a'), null)
})

test('detectFailureWithAI：解析 JSON 数组（容忍代码块包裹），只保留字符串字段', async () => {
  process.env.DSH_SAFE_AI_KEY = 'test-key'
  stubFetch(() => okResponse('```json\n[{"packageName":"@a/b","entryId":"row1","reason":"boom"},{"bad":1}]\n```'))
  const picks = await detectFailureWithAI('stderr', [{ id: 'row1', name: '@a/b' }])
  assert.deepEqual(picks, [{ packageName: '@a/b', entryId: 'row1', reason: 'boom' }])
})

test('detectFailureWithAI：空对照表不发请求；坏 JSON → []', async () => {
  process.env.DSH_SAFE_AI_KEY = 'test-key'
  const calls = stubFetch(() => okResponse('[]'))
  assert.deepEqual(await detectFailureWithAI('stderr', []), [])
  assert.equal(calls.length, 0)
  stubFetch(() => okResponse('totally not json'))
  assert.deepEqual(await detectFailureWithAI('stderr', [{ id: 'r', name: '@a/b' }]), [])
})

test('detectFailureWithAI：接口失败 → null（调用方照旧透传）', async () => {
  process.env.DSH_SAFE_AI_KEY = 'test-key'
  globalThis.fetch = async () => {
    throw new Error('down')
  }
  assert.equal(await detectFailureWithAI('stderr', [{ id: 'r', name: '@a/b' }]), null)
})
