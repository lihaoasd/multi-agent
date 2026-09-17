import { rmSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { buildContainer, resolveDeps, type AppDeps } from '../src/bootstrap/composition-root'
import type { WsRealtime } from '../src/ports/events'
import type { ModelGateway } from '../src/ports/model'
import { TOKENS } from '../src/ports/tokens'
import { createServer } from '../src/server/app'
import { buildAppConfig, type AppConfig } from '../src/shared/config'
import { createRecordingForwardingBroadcaster, createTestLogger } from './helpers'

export interface TestContext {
  readonly app: FastifyInstance
  readonly deps: AppDeps
  readonly config: AppConfig
  /** 录制 + 转发到真实 WS Hub 的广播器（断言事件用；事件同时会推给 WS 连接） */
  readonly broadcaster: ReturnType<typeof createRecordingForwardingBroadcaster>
  /** 该用例独占的数据目录（相对 cwd，位于 .test-tmp/ 下） */
  readonly dataDir: string
  /** 数据根（`dataDir = <root>/data`）；传给 `createTestServer({ root })` 可模拟进程重启 */
  readonly root: string
  cleanup(): Promise<void>
}

export interface TestContextOptions {
  /** 前端静态资源目录；null=纯 API 模式（默认） */
  readonly webDistDir?: string | null
  /** 注入的环境映射（模拟 `.env`：遗留导入与 env 模式凭证都从这里读） */
  readonly envMap?: Readonly<Record<string, string | undefined>>
  /** 复用既有数据根（模拟"进程重启"：新容器/新服务实例，磁盘数据不变） */
  readonly root?: string
  /** cleanup 时是否删除数据根；复用他人创建的根时传 false */
  readonly cleanupRoot?: boolean
  /** 模型网关替身（脚本化替身剧本用；缺省取容器内的真实网关） */
  readonly gateway?: ModelGateway
}

/**
 * 组装一个完整的测试上下文（容器 + 服务 + server）。
 * 数据目录独占：`.test-tmp/<stamp>/`（testing/plan.md §3：测后清理，不碰真实 data/ 与 workdir）。
 */
export async function createTestServer(options: TestContextOptions = {}): Promise<TestContext> {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const root = options.root ?? `.test-tmp/${stamp}`
  const dataDir = `${root}/data`
  const envMap = options.envMap ?? {}
  // 与生产装配一致：先由环境映射合成平台配置（`MODELS__DEFAULT` 等键因此对测试同样生效），
  // 再覆盖数据根相关项，保证每个用例的数据目录独占、互不污染。
  const base = buildAppConfig(envMap)
  const config: AppConfig = {
    ...base,
    dataDir,
    roleDirs: ['src/shared/roles', `${dataDir}/roles`],
    models: { ...base.models, configFile: `${dataDir}/model-config.json` },
  }

  const container = buildContainer({ config, logger: createTestLogger(), envMap })
  // 真实 WS Hub 在容器里；录制广播器**转发**给它，既能断言事件、又能走通 WS 链路
  const realtime = container.resolve<WsRealtime>(TOKENS.Realtime)
  const broadcaster = createRecordingForwardingBroadcaster(realtime)
  const deps = resolveDeps(container, {
    broadcaster,
    envMap,
    ...(options.gateway === undefined ? {} : { gateway: options.gateway }),
  })

  // 与生产启动路径一致：空配置时初始化（遗留 env 导入；S10 起**不再有任何假模型兜底**）
  const initialized = await deps.modelConfig.ensureInitialized()
  if (!initialized.ok) throw new Error(`测试上下文初始化模型配置失败：${initialized.error.message}`)

  const staticDir = options.webDistDir ?? null
  const app = await createServer({
    config,
    logger: deps.logger,
    staticAssets: { distDir: () => staticDir },
    services: {
      modelConfig: deps.modelConfig,
      agentConfig: deps.agentConfig,
      agentReferences: deps.agentReferences,
      project: deps.project,
      team: deps.team,
      sessions: deps.sessions,
      dispatcher: deps.dispatcher,
      realtime,
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
      broadcaster,
    },
  })

  return {
    app,
    deps,
    config,
    broadcaster,
    dataDir,
    root,
    async cleanup(): Promise<void> {
      await app.close()
      await container.dispose()
      if (options.cleanupRoot !== false) rmSync(root, { recursive: true, force: true })
    },
  }
}
