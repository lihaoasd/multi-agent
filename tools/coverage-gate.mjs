#!/usr/bin/env node
/**
 * 文件级"测试触达"门禁（S9）：仓库未引入覆盖率依赖（`@vitest/coverage-v8` 需新增依赖与联网安装），
 * 因此用**可达性**替代行覆盖率：从全部测试文件出发做**传递 import 图**遍历，
 * 每个 `src/**\/*.ts` 必须可达（直接或间接被加载），或在白名单内（进程入口）。
 *
 * 用法：`npm run coverage`（失败退出码 1）。输出按层统计与不可达清单。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')
const TESTS = join(ROOT, 'tests')

/** 白名单：独立进程入口（由运维/命令行直接执行，不被测试 import） */
const WHITELIST = new Set(['bootstrap/main.ts', 'bootstrap/reindex.ts'])

function walk(dir, filter, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, filter, out)
    else if (filter(entry)) out.push(full)
  }
  return out
}

const sourceFiles = walk(SRC, (name) => name.endsWith('.ts'))
const testFiles = walk(TESTS, (name) => name.endsWith('.ts'))

const resolveSpecifier = (fromFile, spec) => {
  const base = resolve(dirname(fromFile), spec)
  for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

const importsOf = (file) => {
  const text = readFileSync(file, 'utf8')
  const specs = []
  for (const match of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) specs.push(match[1])
  return specs
}

/** 从测试文件出发做传递可达遍历 */
const visited = new Set()
const queue = [...testFiles]
while (queue.length > 0) {
  const file = queue.pop()
  if (visited.has(file)) continue
  visited.add(file)
  for (const spec of importsOf(file)) {
    const target = resolveSpecifier(file, spec)
    if (target !== null && !visited.has(target)) queue.push(target)
  }
}

const layerOf = (file) => {
  const rel = relative(SRC, file).replace(/\\/g, '/')
  const parts = rel.split('/')
  return parts.length > 1 ? parts[0] : '(root)'
}

const stats = new Map()
const unreachable = []
for (const file of sourceFiles) {
  const rel = relative(SRC, file).replace(/\\/g, '/')
  const layer = layerOf(file)
  const bucket = stats.get(layer) ?? { total: 0, touched: 0 }
  bucket.total += 1
  if (visited.has(file)) bucket.touched += 1
  else if (!WHITELIST.has(rel)) unreachable.push(rel)
  stats.set(layer, bucket)
}

/** 门禁输出走 stdout（允许：脚本用途即报告） */
const report = (line) => process.stdout.write(`${line}\n`)

report('[coverage] 源码可达性统计（测试 → 传递 import 图）：')
for (const [layer, bucket] of [...stats.entries()].sort()) {
  report(`  - ${layer}: ${bucket.touched}/${bucket.total}`)
}
report(`[coverage] 可达 ${sourceFiles.length - unreachable.length}/${sourceFiles.length}（白名单 ${WHITELIST.size} 个进程入口）`)

if (unreachable.length > 0) {
  console.error('[coverage] 以下源码文件未被任何测试可达：')
  for (const file of unreachable) console.error(`  - src/${file}`)
  console.error('[coverage] 门禁失败：请补测试，或把确有必要的进程入口加入 tools/coverage-gate.mjs 白名单。')
  process.exitCode = 1
} else {
  report('[coverage] 门禁通过：所有源码文件均被测试路径可达。')
}
