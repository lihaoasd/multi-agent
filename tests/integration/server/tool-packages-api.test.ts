import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestServer, type TestContext } from '../../helpers-server'

/**
 * S13（D23）：工具包归属口径 —— `ask_user` 独立为 **`interaction`（交互）** 包。
 *
 * 两件事必须同时成立，缺一个就会出现"包声明与运行期注册元数据不一致"：
 * ① `infra/tools/packages.ts` 的**声明**（`/api/tool-packages` 展示用）；
 * ② 工具注册时的 `package` 字段（`/api/tools` 与按包归档的真源）。
 * 因此本文件对两者做一致性断言（这正是本次需求暴露出的风险点）。
 */

interface PackageBody {
  id: string
  name: string
  required: boolean
  tools: Array<{ name: string; registered: boolean }>
}

interface ToolBody {
  name: string
  package: string
  description: string
}

const EXPECTED_PACKAGES = ['approval', 'artifact', 'cmd', 'fs', 'interaction', 'memory', 'session', 'task']

describe('API · 工具包归属（S13：ask_user → interaction）', () => {
  let context: TestContext

  beforeAll(async () => {
    context = await createTestServer()
  })

  afterAll(async () => {
    await context.cleanup()
  })

  const inject = async (options: InjectOptions): Promise<LightMyRequestResponse> => context.app.inject(options)

  it('基础包为 8 个且全部 required；ask_user 只在 interaction 包里', async () => {
    const packages = (await inject({ method: 'GET', url: '/api/tool-packages' })).json<PackageBody[]>()
    expect(packages.map((item) => item.id).sort()).toEqual(EXPECTED_PACKAGES)
    expect(packages.every((item) => item.required)).toBe(true)

    const interaction = packages.find((item) => item.id === 'interaction')
    expect(interaction?.name).toBe('交互')
    expect(interaction?.tools.map((tool) => tool.name)).toEqual(['ask_user'])
    expect(interaction?.tools.every((tool) => tool.registered)).toBe(true)

    const task = packages.find((item) => item.id === 'task')
    expect(task?.tools.map((tool) => tool.name)).not.toContain('ask_user')
    expect(task?.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['task_view', 'task_list', 'task_assign', 'task_claim', 'task_update']),
    )

    // S21/D27：session 包新增 session_recent（Agent 自查本会话事件，用于判断上一回合是否收尾）
    const session = packages.find((item) => item.id === 'session')
    expect(session?.tools.map((tool) => tool.name)).toEqual(['session_search', 'session_recent'])
    expect(session?.tools.every((tool) => tool.registered)).toBe(true)
  })

  it('声明与注册元数据一致：每个被声明的工具，其 `package` 字段等于声明它的包', async () => {
    const packages = (await inject({ method: 'GET', url: '/api/tool-packages' })).json<PackageBody[]>()
    const tools = (await inject({ method: 'GET', url: '/api/tools' })).json<ToolBody[]>()
    const byName = new Map(tools.map((tool) => [tool.name, tool]))

    for (const item of packages) {
      for (const tool of item.tools) {
        const definition = byName.get(tool.name)
        expect(definition, `未注册的工具：${tool.name}`).toBeDefined()
        expect(definition?.package, `工具 ${tool.name} 的 package 字段与声明不一致`).toBe(item.id)
      }
    }

    // 反向：注册表里的每个工具都必须被某个包声明（否则工具在界面上"无家可归"）
    const declared = new Set(packages.flatMap((item) => item.tools.map((tool) => tool.name)))
    for (const tool of tools) {
      expect(declared.has(tool.name), `工具 ${tool.name} 未被任何工具包声明`).toBe(true)
    }
  })

  it('8 个内置模板都挂载 interaction 包（改包后角色仍能向用户提问）', async () => {
    const templates = (
      await inject({ method: 'GET', url: '/api/agent-templates' })
    ).json<Array<{ roleId: string; source: string; packages: string[]; tools: string[] }>>()
    const builtin = templates.filter((item) => item.source === 'builtin')
    expect(builtin).toHaveLength(8)
    for (const template of builtin) {
      expect(template.packages, `${template.roleId} 未挂载 interaction`).toContain('interaction')
      expect(template.tools, `${template.roleId} 白名单缺少 ask_user`).toContain('ask_user')
      // S21/D27：每个角色都要能自查中断（否则平台不再判定后，中断就没人能发现）
      expect(template.tools, `${template.roleId} 白名单缺少 session_recent`).toContain('session_recent')
      // S25：8 个基础包「全员必装」——每个内置模板的挂载清单必须完整覆盖
      for (const packageId of EXPECTED_PACKAGES) {
        expect(template.packages, `${template.roleId} 未挂载基础包 ${packageId}`).toContain(packageId)
      }
    }
  })
})
