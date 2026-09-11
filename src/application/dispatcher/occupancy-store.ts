/**
 * dispatcher occupancy（D18-④ 单工运行期占用唯一真相）。
 * 落盘 runtime.state.json；user 会话 suspended 由它派生；启动时按 log/meta 重建基线后以本文件为准。
 */
import { join } from 'node:path'

import { atomicWriteJson, readJson } from '../../infra/file-store/fs-utils.js'

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

export class OccupancyStore {
  constructor(private readonly projectsRoot: string) {}

  private file(projectId: string): string {
    return join(this.projectsRoot, projectId, 'runtime.state.json')
  }

  async read(projectId: string): Promise<RuntimeState> {
    const st = await readJson<RuntimeState>(this.file(projectId))
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
    await atomicWriteJson(this.file(projectId), st)
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
    await atomicWriteJson(this.file(projectId), st)
  }

  async get(projectId: string, instanceId: string): Promise<AgentOccupancy | null> {
    const st = await this.read(projectId)
    return st.occupancy[instanceId] ?? null
  }
}
