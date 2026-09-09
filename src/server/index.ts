/**
 * 服务入口（tsx src/server/index.ts / node dist/server/index.js 直接运行）：
 * 加载 config.yaml → 组装依赖 → 监听端口。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { loadConfig, type ConfigFileShape } from '../shared/config.js'
import { rootLogger } from '../infra/util/log.js'
import { composeServices } from '../application/composition.js'
import { buildApp } from './app.js'

const logger = rootLogger()

/** 读取仓库根 config.yaml（无密钥；敏感项走环境变量）。 */
async function readConfigFile(cwd: string): Promise<ConfigFileShape> {
  try {
    const raw = await readFile(join(cwd, 'config.yaml'), 'utf8')
    return (parseYaml(raw) ?? {}) as ConfigFileShape
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

async function bootstrap(cwd: string = process.cwd()): Promise<void> {
  const file = await readConfigFile(cwd)
  const config = loadConfig(file, cwd)
  const svc = composeServices(config)
  const app = await buildApp(svc)
  const { host, port } = config.server
  await app.listen({ host, port })
  logger.info(`Agent Haness 已启动: http://${host}:${port}`)
}

bootstrap().catch((err) => {
  logger.error('启动失败', err)
  process.exit(1)
})
