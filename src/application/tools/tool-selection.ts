/**
 * 工具可用性判定（**单点真相**，2026-09-13）。
 *
 * 角色"实际能用哪些工具" = 角色白名单 × 会话类型 × 注册表，另加一批**平台交互工具**
 * （user 会话始终可用，不依赖角色模板快照；老项目快照的 tools 里没有也能用）。
 *
 * 运行期（`composition.listTools`，喂给模型的 function-calling schema）与「角色详情」查询
 * （`GET /api/projects/:pid/agents/:iid`）共用本文件，避免两处各自维护过滤规则而漂移。
 */
import { listToolDefs, type ToolDef } from '../../infra/tools/executor.js'
import type { TeamMemberConfig } from '../../shared/types/project.js'

/** 平台交互工具：user 会话始终可用（不依赖角色白名单快照）。 */
export const PLATFORM_USER_TOOLS = new Set([
  'ask_user',
  'task_assign',
  'task_claim',
  'task_update',
  'artifact_submit',
])

/** 生效工具条目（详情视图用）。 */
export interface EffectiveTool {
  name: string
  /** whitelist=角色白名单里配了；platform=平台交互工具（user 会话默认可用） */
  source: 'whitelist' | 'platform'
  /** 该工具在哪些会话类型可用（user/meeting） */
  availableIn: string[]
}

/** 白名单里配了、但当前会话类型下用不上的工具（详情视图用，便于发现过时配置）。 */
export interface UnavailableTool {
  name: string
  /**
   * 已注册时给出其可用会话类型（据此可判断"仅会议会话可用"）；
   * **缺省 = 注册表里已没有**（工具下线/改名/尚未实现）。
   */
  availableIn?: string[]
}

export interface ToolAvailability {
  effective: EffectiveTool[]
  unavailable: UnavailableTool[]
}

/**
 * 该角色在指定会话类型下**实际暴露给模型**的工具定义（运行期与详情查询共用）。
 * 注意顺序：沿用注册表顺序（与改造前 composition 的内联实现一致）。
 */
export function selectToolDefs(
  member: Pick<TeamMemberConfig, 'tools'>,
  sessionType: string,
): Array<ToolDef & { availableIn: string[] }> {
  const allowed = new Set(member.tools ?? [])
  return listToolDefs().filter(
    (d) =>
      d.availableIn.includes(sessionType) &&
      (allowed.has(d.name) || (sessionType === 'user' && PLATFORM_USER_TOOLS.has(d.name))),
  )
}

/** 角色详情用：生效工具（带来源）+ 白名单里配了却用不上的（带原因）。 */
export function describeToolAvailability(
  member: Pick<TeamMemberConfig, 'tools'>,
  sessionType = 'user',
): ToolAvailability {
  const allowed = new Set(member.tools ?? [])
  const defs = listToolDefs()
  const effective: EffectiveTool[] = selectToolDefs(member, sessionType).map((d) => ({
    name: d.name,
    source: allowed.has(d.name) ? 'whitelist' : 'platform',
    availableIn: d.availableIn,
  }))
  const live = new Set(effective.map((t) => t.name))
  const unavailable: UnavailableTool[] = (member.tools ?? [])
    .filter((n) => !live.has(n))
    .map((n) => {
      const def = defs.find((d) => d.name === n)
      return def ? { name: n, availableIn: def.availableIn } : { name: n }
    })
  return { effective, unavailable }
}
