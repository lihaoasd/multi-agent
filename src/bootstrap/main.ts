import { createServer } from '../server/app'
import { loadEnvMap } from '../infra/config/env-config'
import { buildContainer, resolveDeps } from './composition-root'
import { recoverOnStartup } from './startup'

async function main(): Promise<void> {
  // `.env` 文件内容不会写回 process.env，故显式加载一次并同时用于配置与遗留导入
  const envMap = loadEnvMap()
  const container = buildContainer({ envMap })
  const deps = resolveDeps(container, { envMap })

  // 首次启动的遗留配置导入（`.env` 的 MODELS__PROVIDERS → data/model-config.json，model-config.md §11）
  const initialized = await deps.modelConfig.ensureInitialized()
  if (!initialized.ok) {
    deps.logger.warn('模型配置初始化失败', { code: initialized.error.code, message: initialized.error.message })
  } else if (initialized.value.imported > 0) {
    deps.logger.info('已从 .env 导入遗留模型配置', { imported: initialized.value.imported })
  }

  const app = await createServer({
    config: deps.config,
    logger: deps.logger,
    staticAssets: deps.staticAssets,
    services: {
      modelConfig: deps.modelConfig,
      agentConfig: deps.agentConfig,
      agentReferences: deps.agentReferences,
      project: deps.project,
      team: deps.team,
      sessions: deps.sessions,
      dispatcher: deps.dispatcher,
      realtime: deps.realtime,
      ids: deps.ids,
      approvals: deps.approvals,
      memory: deps.memory,
      search: deps.search,
      artifacts: deps.artifacts,
      tasks: deps.tasks,
      questions: deps.questions,
      orchestration: deps.orchestration,
      runtime: deps.runtime,
      exporter: deps.exporter,
      toolRegistry: deps.toolRegistry,
      toolPackages: deps.toolPackages,
      loopRegistry: deps.loopRegistry,
      promptPreview: deps.promptPreview,
      broadcaster: deps.broadcaster,
    },
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
    providers: deps.kinds.list().length,
  })

  // 启动自检（S47/D50）：清残留占用 + 补处理排队消息（D18-③）——否则重启后"看起来全死了"。
  // ⚠️ 必须在 `listen` **之后**且**不阻塞**：补处理会真的跑 Agent 回合（可能几分钟），
  // 放在 listen 之前会把 HTTP 服务一起挡住，前端只会看到 ECONNREFUSED。
  void recoverOnStartup({ project: deps.project, dispatcher: deps.dispatcher, logger: deps.logger }).catch(
    (cause: unknown) => {
      deps.logger.warn('启动自检失败', { message: cause instanceof Error ? cause.message : String(cause) })
    },
  )
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  process.stderr.write(`启动失败：${message}\n`)
  process.exitCode = 1
})
