/**
 * 服务入口（tsx src/server/index.ts / node dist/server/index.js 直接运行）：
 * 定位仓库根 → 加载 config.yaml → 组装依赖 → 监听端口（含 web/ 静态托管）。
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { loadConfig, type ConfigFileShape } from '../shared/config.js'
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

async function bootstrap(cwd: string = process.cwd()): Promise<void> {
  const repoRoot = await findRepoRoot(cwd)
  const file = await readConfigFile(repoRoot)
  const config = loadConfig(file, repoRoot)
  const svc = composeServices(config)
  // 静态托管 web/：统一在 buildApp 内注册（便于测试覆盖），no-cache 强制校验、避免旧前端被缓存
  const webDir = join(repoRoot, 'web')
  const app = await buildApp(svc, { webDir })

  const { host, port: cfgPort } = config.server
  // 允许环境变量覆盖端口（本地部署/测试），其余配置以 config.yaml 为准
  const port = process.env.PORT ? Number(process.env.PORT) : cfgPort
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

async function readConfigFile(repoRoot: string): Promise<ConfigFileShape> {
  try {
    const raw = await readFile(join(repoRoot, 'config.yaml'), 'utf8')
    return (parseYaml(raw) ?? {}) as ConfigFileShape
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

bootstrap().catch((err) => {
  logger.error('启动失败', err)
  process.exit(1)
})
