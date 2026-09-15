/**
 * 检索索引重建入口（`npm run reindex`）。
 * S0 阶段尚无索引后端（S5 接入 SearchIndex 端口与 search-index/ 目录），
 * 这里保持命令可用并如实说明现状，不做假实现。
 */
async function main(): Promise<void> {
  process.stdout.write('索引重建：当前没有可重建的索引后端（在 S5 阶段接入 SearchIndex 端口）。\n')
}

main().catch((error: unknown) => {
  process.stderr.write(`索引重建失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
