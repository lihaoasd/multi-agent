/**
 * 应用级工具注册入口（P3d，2026-09-14）。
 *
 * 本文件原先 998 行、内含 12 个 `registerTool` 调用。现按"少数大块"拆到 `./impl/`：
 *
 * | 文件 | 工具 | 会话可见 |
 * | --- | --- | --- |
 * | `impl/memory-search-tools.ts` | `memory_append` / `memory_search` / `session_search` | user + meeting |
 * | `impl/workdir-edit.ts` | `workdir_edit`（项目目录唯一写通道） | user |
 * | `impl/ask-user.ts` | `ask_user` | user |
 * | `impl/artifact-submit.ts` | `artifact_submit` | user |
 * | `impl/task-tools.ts` | `task_assign` / `task_claim` / `task_update` | user |
 * | `impl/platform-tools.ts` | `meeting_start` / `meeting_close` / `meeting_talk` | user |
 *
 * 本文件只做三件事：组装共享依赖 `ServiceToolDeps`、按固定顺序调用各组的 `register*`、导出类型。
 * **注册顺序与拆分前一致**（顺序影响工具在模型侧 schema 列表中的先后）。
 *
 * 权限与边界（未改变）：`memory_append` 的 `scope=global` 仅 pm_1（D18-②）；
 * `workdir_edit` 是项目工作目录唯一写通道，按 taskId 聚合、按 file-owners 校验归属；
 * `meetingsEnabled=false` 时三个会议工具**不注册**（角色连"能开会"都不知道）。
 */
import type { MemoryStore } from '../memory/memory-store.js'
import type { SearchService } from '../search/search-service.js'
import type { CodeEditStore } from '../code-edit/code-edit-store.js'
import type { QuestionService } from '../question/question-service.js'
import type { TaskService } from '../task/task-service.js'
import type { MeetingService } from '../meeting/meeting-service.js'
import type { ArtifactService } from '../artifact/artifact-service.js'
import type { FileOwnerStore } from '../artifact/file-owner-store.js'
import type { TeamMemberConfig } from '../../shared/types/project.js'

import type { MeetingChainInput, ServiceToolDeps } from './impl/context.js'
import { registerMemorySearchTools } from './impl/memory-search-tools.js'
import { registerWorkdirEditTool } from './impl/workdir-edit.js'
import { registerAskUserTool } from './impl/ask-user.js'
import { registerArtifactSubmitTool } from './impl/artifact-submit.js'
import { registerTaskTools } from './impl/task-tools.js'
import { registerPlatformTools } from './impl/platform-tools.js'

/** 会议讨论链入参（re-export，既有调用方不受影响）。 */
export type { MeetingChainInput }

/** `ws://docs/a.md` → `docs/a.md`（提交到项目目录时的默认相对路径）。 */
function stripWs(p: string): string {
  return p.replace(/^ws:\/\//, '').replace(/^[/\\]+/, '')
}

/** 该会话是否对该 Agent 可见（user 会话限本人；meeting 会话对参会者可见）。 */
function isVisibleTo(sessionId: string | undefined, env: { instanceId: string }): boolean {
  if (!sessionId) return false
  if (sessionId.startsWith('u_')) return sessionId === `u_${env.instanceId}`
  // meeting 会话对参会 Agent 可见（MVP 简化）
  return sessionId.startsWith('m_')
}

export function registerServiceTools(deps: {
  memory: MemoryStore
  search: SearchService
  codeEdits: CodeEditStore
  questions?: QuestionService
  tasks?: TaskService
  meetings?: MeetingService
  listTeam?: (projectId: string) => Promise<TeamMemberConfig[]>
  /** 产出物提交（项目工作目录就地登记 + 版本快照） */
  artifacts?: ArtifactService
  /** 产出物署名与归属（file-owners）：写前校验、写后认领 */
  fileOwners?: FileOwnerStore
  /** 会议讨论链（见 `./impl/context.ts` 的同名说明） */
  runMeetingChain?: (input: MeetingChainInput) => Promise<void>
  /** 会议功能是否启用（`config.meeting.enabled`）。缺省 true。 */
  meetingsEnabled?: boolean
}): void {
  const ctx: ServiceToolDeps = {
    ...deps,
    meetingsEnabled: deps.meetingsEnabled ?? true,
    stripWs,
    isVisibleTo,
  }

  // 注册顺序与拆分前一致（原文件内的出现顺序）
  registerMemorySearchTools(ctx)
  registerWorkdirEditTool(ctx)
  registerAskUserTool(ctx)
  registerArtifactSubmitTool(ctx)
  registerTaskTools(ctx)
  registerPlatformTools(ctx)
}