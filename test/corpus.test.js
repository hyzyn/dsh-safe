import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFailureReport } from '../lib/failures.js'

/**
 * 解析器语料库：每个 .txt 是一段真实形态的 dsh 启动失败 stderr，同名 .json
 * 是期望的识别结果（names/entryIds，断言时排序比较）。dsh 未来改报错格式时，
 * 往这里加新样本即可，无需改测试代码。
 */
const FIXTURES = join(dirname(dirname(fileURLToPath(import.meta.url))), 'test', 'fixtures', 'dsh-stderr')

const files = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.txt'))
  .sort()

test(`语料库规模：至少 6 个样本（当前 ${files.length} 个）`, () => {
  assert.ok(files.length >= 6)
})

for (const file of files) {
  test(`语料库 ${file}`, () => {
    const stderr = readFileSync(join(FIXTURES, file), 'utf8')
    const expected = JSON.parse(readFileSync(join(FIXTURES, file.replace(/\.txt$/, '.json')), 'utf8'))
    const actual = parseFailureReport(stderr)
    const detail = `${file}\n  names: ${JSON.stringify(actual.names.map(([n]) => n))}\n  entryIds: ${JSON.stringify(actual.entryIds.map(([id]) => id))}`
    assert.deepEqual(
      actual.names.map(([n]) => n).sort(),
      [...expected.names].sort(),
      detail,
    )
    assert.deepEqual(
      actual.entryIds.map(([id]) => id).sort(),
      [...expected.entryIds].sort(),
      detail,
    )
  })
}
