import { rmSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { buildContainer, resolveDeps, type AppDeps } from '../src/bootstrap/composition-root'
import { createRecordingEventBroadcaster } from '../src/infra/events/noop-broadcaster'
import { createServer } from '../src/server/app'
import { DEFAULT_APP_CONFIG, type AppConfig } from '../src/shared/config'
import { createTestLogger } from './helpers'

export interface TestContext {
  readonly app: FastifyInstance
  readonly deps: AppDeps
  readonly config: AppConfig
  readonly broadcaster: ReturnType<typeof createRecordingEventBroadcaster>
  /** 该用例独占的数据目录（相对 cwd，位于 .test-tmp/ 下） */
  readonly dataDir: string
  cleanup(): Promise<void>
}

export interface TestContextOptions {
  /** 前端静态资源目录；null=纯 API 模式（默认） */
  readonly webDistDir?: string | null
  /** 注入的环境映射（模拟 `.env`：遗留导入与 env 模式凭证都从这里读） */
  readonly envMap?: Readonly<Record<string, string | undefined>>
}

/**
 * 组装一个完整的测试上下文（容器 + 服务 + server）。
 * 数据目录独占：`.test-tmp/<stamp>/`（testing/plan.md §3：测后清理，不碰真实 data/ 与 workdir）。
 */
export async function createTestServer(options: TestContextOptions = {}): Promise<TestContext> {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const root = `.test-tmp/${stamp}`
  const dataDir = `${root}/data`
  const config: AppConfig = {
    ...DEFAULT_APP_CONFIG,
    dataDir,
    roleDirs: ['src/shared/roles', `${dataDir}/roles`],
    models: { ...DEFAULT_APP_CONFIG.models, configFile: `${dataDir}/model-config.json` },
  }

  const envMap = options.envMap ?? {}
  const container = buildContainer({ config, logger: createTestLogger(), envMap })
  const broadcaster = createRecordingEventBroadcaster()
  const deps = resolveDeps(container, { broadcaster, envMap })
  // 与生产启动路径一致：空配置时初始化（遗留导入 → 内置 Mock 兜底）
  const initialized = await deps.modelConfig.ensureInitialized()
  if (!initialized.ok) throw new Error(`测试上下文初始化模型配置失败：${initialized.error.message}`)
  const staticDir = options.webDistDir ?? null
  const app = await createServer({
    config,
    logger: deps.logger,
    staticAssets: { distDir: () => staticDir },
    services: { modelConfig: deps.modelConfig, agentConfig: deps.agentConfig, broadcaster },
  })

  return {
    app,
    deps,
    config,
    broadcaster,
    dataDir,
    async cleanup(): Promise<void> {
      await app.close()
      await container.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}
