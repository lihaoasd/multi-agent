import { loadEnvMap } from '../infra/config/env-config'
import { buildContainer, resolveDeps } from './composition-root'

/**
 * 检索索引重建入口（`npm run reindex [--project <id>]`）。
 * `search-index/index.json` 是**派生投影**：删除或损坏都不影响业务，本命令按项目全量重扫重建
 * （data-storage.md §9/§10）。省略 `--project` 时重建全部项目。
 */
async function main(): Promise<void> {
  const envMap = loadEnvMap()
  const container = buildContainer({ envMap })
  const deps = resolveDeps(container, { envMap })

  const projectArgIndex = process.argv.indexOf('--project')
  const only = projectArgIndex >= 0 ? process.argv[projectArgIndex + 1] : undefined

  const projects = await deps.project.list()
  if (!projects.ok) {
    process.stderr.write(`索引重建失败：${projects.error.message}\n`)
    process.exitCode = 1
    return
  }

  const targets = projects.value.filter((item) => only === undefined || item.id === only)
  if (targets.length === 0) {
    process.stdout.write(only === undefined ? '索引重建：没有项目需要处理。\n' : `索引重建：项目不存在：${only}\n`)
    if (only !== undefined) process.exitCode = 1
    return
  }

  let failed = 0
  for (const project of targets) {
    const stats = await deps.search.reindex(project.id)
    if (!stats.ok) {
      failed += 1
      process.stdout.write(`- ${project.id} ${project.name}：失败（${stats.error.code}）${stats.error.message}\n`)
      continue
    }
    process.stdout.write(
      `- ${project.id} ${project.name}：文档 ${stats.value.documents} 条，词元 ${stats.value.tokens} 个，builtAt=${stats.value.builtAt ?? '-'}\n`,
    )
  }
  process.stdout.write(`索引重建完成：项目 ${targets.length - failed}/${targets.length} 成功。\n`)
  await container.dispose()
  if (failed > 0) process.exitCode = 1
}

main().catch((error: unknown) => {
  process.stderr.write(`索引重建失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
