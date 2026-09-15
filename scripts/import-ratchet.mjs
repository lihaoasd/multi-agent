/**
 * 依赖门禁 ratchet（abstraction.md §2/§11）：
 * 统计 ESLint `no-restricted-imports`（六层越层依赖）的违规数，与基线比较——
 * **只允许减少**：`npm run ratchet` 超出基线即失败；`npm run ratchet -- --update` 下调基线。
 * 用 ESLint Node API 而非子进程，避免受限环境下的 piped stdio 限制。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { ESLint } from 'eslint'

const RULE_ID = 'no-restricted-imports'
const baselinePath = resolve(process.cwd(), 'tools/import-ratchet.json')
const shouldUpdate = process.argv.includes('--update')

const eslint = new ESLint({ cwd: process.cwd() })
const results = await eslint.lintFiles(['src', 'web/src'])

const byFile = new Map()
let count = 0
for (const result of results) {
  for (const message of result.messages) {
    if (message.ruleId !== RULE_ID) continue
    count += 1
    byFile.set(result.filePath, (byFile.get(result.filePath) ?? 0) + 1)
  }
}

const baseline = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, 'utf8'))
  : {}
const allowed = typeof baseline[RULE_ID] === 'number' ? baseline[RULE_ID] : 0

if (shouldUpdate) {
  mkdirSync(dirname(baselinePath), { recursive: true })
  writeFileSync(baselinePath, `${JSON.stringify({ [RULE_ID]: count }, null, 2)}\n`, 'utf8')
  process.stdout.write(`[ratchet] 基线已更新：${RULE_ID}=${count}\n`)
  process.exit(0)
}

if (count > allowed) {
  console.error(`[ratchet] 越层依赖违规增加：当前 ${count} 处 > 基线 ${allowed} 处`)
  for (const [file, hits] of byFile) {
    console.error(`  - ${file}：${hits} 处`)
  }
  console.error('[ratchet] 请消除越层 import（abstraction.md §2）；如确为设计变更，先改文档再 --update。')
  process.exit(1)
}

process.stdout.write(`[ratchet] 依赖门禁通过：${RULE_ID} 违规 ${count} 处（基线 ${allowed} 处）\n`)
