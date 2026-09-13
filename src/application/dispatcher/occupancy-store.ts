/**
 * dispatcher occupancy（D18-④ 单工运行期占用唯一真相）。
 * 落盘 runtime.state.json；user 会话 suspended 由它派生；启动时按 log/meta 重建基线后以本文件为准。
 *
 * 重构 P1（2026-09-14）：持久化改走 `ProjectStore` 门面（`infra/store`），本文件不再直接触碰 fs。
 */
import type { ProjectStore } from '../../infra/store/project-store.js'

export type AgentActivityType = 'working' | 'meeting' | 'waiting'

export interface AgentOccupancy {
  /** 活动会话（user=u_<iid> / meeting=m_…） */
  sessionId: string
  activity: AgentActivityType
  since: string
}

export interface RuntimeState {
  schemaVersion: 1
  occupancy: Record<string, AgentOccupancy>
}

const FILE = 'runtime.state.json'

export class OccupancyStore {
  constructor(private readonly store: ProjectStore) {}

  async read(projectId: string): Promise<RuntimeState> {
    const st = await this.store.readJson<RuntimeState>(projectId, FILE)
    if (st && st.schemaVersion === 1 && st.occupancy) return st
    return { schemaVersion: 1, occupancy: {} }
  }

  async acquire(
    projectId: string,
    instanceId: string,
    sessionId: string,
    activity: AgentActivityType,
  ): Promise<void> {
    const st = await this.read(projectId)
    st.occupancy[instanceId] = { sessionId, activity, since: new Date().toISOString() }
    await this.store.writeJson(projectId, FILE, st)
  }

  /**
   * 释放占用。传 sessionId 时**只释放该会话的占用**——
   * 避免回合结束时把"回合中刚加入的会议占用"一并清掉（主持人状态会丢）。
   */
  async release(projectId: string, instanceId: string, sessionId?: string): Promise<void> {
    const st = await this.read(projectId)
    const cur = st.occupancy[instanceId]
    if (sessionId !== undefined && cur && cur.sessionId !== sessionId) return
    delete st.occupancy[instanceId]
    await this.store.writeJson(projectId, FILE, st)
  }

  async get(projectId: string, instanceId: string): Promise<AgentOccupancy | null> {
    const st = await this.read(projectId)
    return st.occupancy[instanceId] ?? null
  }
}
