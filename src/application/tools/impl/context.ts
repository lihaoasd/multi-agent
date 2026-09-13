/**
 * 服务级工具的共享依赖面（P3d，2026-09-14）。
 *
 * `service-tools.ts` 原先 998 行、含 12 个 `registerTool`。拆分后每个工具组一个文件，
 * 共享的依赖与小工具收敛到这里；`registerServiceTools` 只负责组装并依次调用。
 *
 * 注意：这里**不 import 具体服务实现**，只声明形状（由组合根注入）。
 */
import type { MemoryStore } from '../../memory/memory-store.js'
import type { SearchService } from '../../search/search-service.js'
import type { CodeEditStore } from '../../code-edit/code-edit-store.js'
import type { QuestionService } from '../../question/question-service.js'
import type { TaskService } from '../../task/task-service.js'
import type { MeetingService } from '../../meeting/meeting-service.js'
import type { MeetingRecord } from '../../meeting/meeting-service.js'
import type { ArtifactService } from '../../artifact/artifact-service.js'
import type { FileOwnerStore } from '../../artifact/file-owner-store.js'
import type { TeamMemberConfig } from '../../../shared/types/project.js'

/** 会议讨论链入参（启动时机由调用方决定：立即开会 or 排队被提升后）。 */
export interface MeetingChainInput {
  projectId: string
  meeting: MeetingRecord
  topic: string
  desc: string
  /** 受邀成员（不含主持人） */
  members: string[]
  host: string
}

/** 服务级工具注册所需的全部依赖与共享工具。 */
export interface ServiceToolDeps {
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
  /**
   * 会议讨论链（主持人开场 → 各成员发言 → 主持人收尾 → 满足条件则结束会议）。
   * `meeting_start` 在会议**立即开始**时直接调用；会议因槽位被占而排队时**不调用**。
   */
  runMeetingChain?: (input: MeetingChainInput) => Promise<void>
  /** 会议功能是否启用（`config.meeting.enabled`）。缺省 true。 */
  meetingsEnabled: boolean
  /** `ws://docs/a.md` → `docs/a.md`（提交到项目目录时的默认相对路径）。 */
  stripWs: (p: string) => string
  /** 该会话是否对该 Agent 可见（user 会话限本人；meeting 会话对参会者可见）。 */
  isVisibleTo: (sessionId: string | undefined, env: { instanceId: string }) => boolean
}
