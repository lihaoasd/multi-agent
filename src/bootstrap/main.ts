import { createServer } from '../server/app'
import { buildContainer, resolveDeps } from './composition-root'

async function main(): Promise<void> {
  const container = buildContainer()
  const deps = resolveDeps(container)
  const app = await createServer({
    config: deps.config,
    logger: deps.logger,
    staticAssets: deps.staticAssets,
  })
  const { host, port } = deps.config.server

  const shutdown = async (signal: string): Promise<void> => {
    deps.logger.info('收到退出信号，正在关闭', { signal })
    try {
      await app.close()
      await container.dispose()
    } finally {
      process.exit(0)
    }
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown(signal)
    })
  }

  await app.listen({ host, port })
  deps.logger.info('服务已启动', {
    url: `http://${host}:${port}`,
    health: `http://${host}:${port}/health`,
    dataDir: deps.config.dataDir,
    webDist: deps.staticAssets.distDir(),
  })
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  process.stderr.write(`启动失败：${message}\n`)
  process.exitCode = 1
})
