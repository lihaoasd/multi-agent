/**
 * 服务入口（tsx src/server/index.ts / node dist/server/index.js 直接运行）：
 * 定位仓库根 → 加载 .env → 组装依赖 → 监听端口（含 web/ 静态托管）。
 *
 * 配置**唯一来源是 `.env`**（2026-09-13 起，config.yaml 已删除）：
 * 键名约定见 `shared/config.ts`（双下划线分层、数组用 JSON），模板见入库的 `.env.example`。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { configFromEnv, loadConfig } from '../shared/config.js'
import { rootLogger } from '../infra/util/log.js'
import { composeServices } from '../application/composition.js'
import { buildApp } from './app.js'

const logger = rootLogger()

/** 从 startDir 向上找仓库根（含 package.json 且 name=agent-haness 的目录）。 */
async function findRepoRoot(startDir: string): Promise<string> {
  let dir = startDir
  for (;;) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { name?: string }
      if (pkg.name === 'agent-haness') return dir
    } catch {
      // 继续向上
    }
    const parent = dirname(dir)
    if (parent === dir)
      throw new Error(`找不到仓库根（package.json name=agent-haness）: ${startDir}`)
    dir = parent
  }
}

/**
 * 加载仓库根下的 `.env`（不存在则跳过：部署时可以只用真实环境变量）。
 * 必须在读取任何配置之前调用；已存在的 process.env 优先（外部显式传参不会被 .env 覆盖）。
 */
function loadDotEnv(repoRoot: string): void {
  const file = join(repoRoot, '.env')
  if (!existsSync(file)) {
    logger.warn(`未找到 .env（${file}）：将只使用进程环境变量与内置默认值`)
    return
  }
  process.loadEnvFile(file)
}

async function bootstrap(cwd: string = process.cwd()): Promise<void> {
  const repoRoot = await findRepoRoot(cwd)
  loadDotEnv(repoRoot)
  const config = loadConfig(configFromEnv(process.env), repoRoot)
  const svc = composeServices(config)
  // 静态托管 web/：统一在 buildApp 内注册（便于测试覆盖），no-cache 强制校验、避免旧前端被缓存
  const webDir = join(repoRoot, 'web')
  const app = await buildApp(svc, { webDir })

  const { host, port } = config.server
  await app.listen({ host, port })
  logger.info(`Agent Haness 已启动: http://${host}:${port}  (前端: web/)`)

  // 启动自检恢复（幂等，重启无损 data-storage §9）：会议排队槽位调度重建
  restoreOnBoot(svc, logger).catch((err) => logger.warn('启动恢复扫描未完成: ' + String(err)))
}

/** 启动自检：对每个项目恢复排队会议槽位（queued → proposed，若槽空）。 */
async function restoreOnBoot(
  svc: import('../application/composition.js').Services,
  log: ReturnType<typeof rootLogger>,
): Promise<void> {
  const projects = await svc.projectService.list()
  for (const p of projects) {
    try {
      await svc.meetings.promoteQueuedIfFree(p.id)
      log.info(`启动恢复: 项目 ${p.id} 会议槽位自检完成`)
    } catch (e) {
      log.warn(`启动恢复失败(项目 ${p.id}): ${String(e)}`)
    }
  }
}

bootstrap().catch((err) => {
  logger.error('启动失败', err)
  process.exit(1)
})
