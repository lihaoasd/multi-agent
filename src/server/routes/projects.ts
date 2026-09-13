import type { FastifyInstance } from 'fastify'
import { AppError, ErrorCodes } from '../../shared/errors.js'
import {
  describeToolAvailability,
  type Services,
} from '../../application/composition.js'
import { deriveAgentState } from '../../domain/fsm/agent-state.js'
import type { TeamAddInput, TeamPatchInput } from '../../application/team/team-service.js'

interface CreateProjectBody {
  name?: string
  description?: string
  workdir?: string
  team?: TeamAddInput[]
}

export function registerProjectRoutes(app: FastifyInstance, svc: Services): void {
  const { projectService, teamService } = svc

  app.get('/api/projects', async () => ({ projects: await projectService.list() }))

  /**
   * 平台能力开关（前端据此隐藏入口）：会议关闭时不显示会议区与「＋发起」。
   * 前端只做展示，真正的拒绝在服务端（会议 REST / 工具均被拦）。
   */
  app.get('/api/capabilities', async () => ({
    capabilities: { meeting: svc.config.meeting.enabled !== false },
  }))

  app.post<{ Body: CreateProjectBody }>('/api/projects', async (req, reply) => {
    const body = req.body ?? {}
    if (typeof body.name !== 'string' || typeof body.workdir !== 'string') {
      return reply
        .code(400)
        .send({ code: ErrorCodes.VALIDATION, message: 'name 与 workdir 为必填字符串' })
    }
    const project = await projectService.create({
      name: body.name,
      description: typeof body.description === 'string' ? body.description : undefined,
      workdir: body.workdir,
    })
    if (Array.isArray(body.team) && body.team.length > 0) {
      try {
        for (const t of body.team) await teamService.add(project.id, t)
      } catch (err) {
        await projectService.remove(project.id).catch(() => undefined)
        throw err
      }
    }
    const final = await projectService.get(project.id)
    return reply.code(201).send({ project: final })
  })

  app.get<{ Params: { pid: string } }>('/api/projects/:pid', async (req) => ({
    project: await projectService.get(req.params.pid),
  }))

  app.patch<{
    Params: { pid: string }
    Body: { name?: string; description?: string }
  }>('/api/projects/:pid', async (req) => ({
    project: await projectService.patch(req.params.pid, req.body ?? {}),
  }))

  app.delete<{ Params: { pid: string }; Querystring: { force?: string } }>(
    '/api/projects/:pid',
    async (req, reply) => {
      void req.query
      await projectService.remove(req.params.pid)
      return reply.code(204).send()
    },
  )
}

export function registerTeamRoutes(app: FastifyInstance, svc: Services): void {
  const { teamService, occupancy, tasks, approvals, questions, roleService } = svc

  app.get<{ Params: { pid: string } }>('/api/projects/:pid/team', async (req) => ({
    team: await teamService.list(req.params.pid),
  }))

  /**
   * 团队行投影（**列表与角色详情共用**）：实例配置 + 实时状态 + 当前任务。
   * 状态推导走单点 deriveAgentState（与 WS agent.state 完全一致）。
   */
  async function teamRows(pid: string) {
    const [team, occ, taskList, pendingApprovals, pendingQuestions] = await Promise.all([
      teamService.list(pid),
      occupancy.read(pid),
      tasks.list(pid),
      approvals.list(pid, 'pending'),
      questions.list(pid, { status: 'pending' }),
    ])
    return team.map((member) => {
      const o = occ.occupancy[member.instanceId] ?? null
      // 有待答提问/待批审批 → waiting，优先于 working
      const state = deriveAgentState({
        enabled: member.enabled,
        occupancy: o,
        hasPendingApproval: pendingApprovals.some((a) => a.actor === member.instanceId),
        hasPendingQuestion: pendingQuestions.some((q) => q.asker === member.instanceId),
      })
      const current = taskList.find(
        (t) => t.assignee === member.instanceId && t.state === 'in_progress',
      )
      return {
        member,
        row: {
          instanceId: member.instanceId,
          displayName: member.displayName,
          roleTemplateId: member.roleTemplateId,
          enabled: member.enabled,
          state,
          sessionId: o?.sessionId ?? null,
          since: o?.since ?? null,
          currentTask: current ? { id: current.id, title: current.title } : null,
        },
      }
    })
  }

  /**
   * 团队实时状态（左栏团队列表用）：
   * disabled（停用）/ meeting（会议中）/ working（工作中）/ waiting（等你处理审批或提问）/ idle（空闲），
   * 并附当前进行中任务，便于一眼看出每个角色在干什么。
   */
  app.get<{ Params: { pid: string } }>('/api/projects/:pid/agents', async (req) => ({
    agents: (await teamRows(req.params.pid)).map((r) => r.row),
  }))

  /**
   * 角色详情（只读，2026-09-13）：身份/模型/agent loop/提示词/工具 + 实时状态。
   * 工具按**运行期口径**给出（tool-selection 单点）：生效清单（含来源）+ 白名单里用不上的，
   * 避免"看白名单快照"被已下线工具/平台工具误导。
   */
  app.get<{ Params: { pid: string; iid: string } }>(
    '/api/projects/:pid/agents/:iid',
    async (req) => {
      const { pid, iid } = req.params
      const found = (await teamRows(pid)).find((r) => r.member.instanceId === iid)
      if (!found) throw new AppError(ErrorCodes.NOT_FOUND, `实例不存在: ${iid}`)
      const { member, row } = found
      // 模板可能已被删除（自建模板）：只影响名称展示，不影响角色本身
      const tpl = await roleService.get(member.roleTemplateId).catch(() => null)
      return {
        agent: {
          ...row,
          createdAt: member.createdAt,
          model: member.model,
          loop: {
            strategy: member.loop?.strategy ?? 'direct',
            params: member.loop?.params ?? {},
          },
          // 运行期读的就是 member.prompt ?? ''（loop-runner buildSystemPrompt）：
          // 这里不做模板兜底，避免"看到的"和"跑起来的"不一致。
          prompt: member.prompt ?? '',
          promptSource: member.prompt == null ? 'none' : 'instance',
          tools: describeToolAvailability(member, 'user'),
          template: tpl
            ? { roleId: tpl.roleId, name: tpl.name, category: tpl.category, source: tpl.source }
            : null,
        },
      }
    },
  )

  /**
   * 「完整系统提示词」预览（只读，2026-09-13）：按 user 会话实时拼装角色实际收到的系统提示词，
   * 逐段给出 blocks（origin=role-config/platform）与拼好的 text——说明"配置里的提示词只是第 1 段"。
   * 与运行期同源（application/agent-loop/system-prompt.ts），不落盘、不缓存。
   */
  app.get<{ Params: { pid: string; iid: string } }>(
    '/api/projects/:pid/agents/:iid/system-prompt',
    async (req) => {
      const { pid, iid } = req.params
      const preview = await svc.previewSystemPrompt(pid, iid)
      if (!preview) throw new AppError(ErrorCodes.NOT_FOUND, `实例不存在: ${iid}`)
      return { preview }
    },
  )

  app.post<{ Params: { pid: string }; Body: TeamAddInput }>(
    '/api/projects/:pid/team',
    async (req, reply) => {
      const member = await teamService.add(req.params.pid, req.body ?? {})
      return reply.code(201).send({ member })
    },
  )

  app.patch<{
    Params: { pid: string; iid: string }
    Body: TeamPatchInput
  }>('/api/projects/:pid/team/:iid', async (req) => ({
    member: await teamService.patch(req.params.pid, req.params.iid, req.body ?? {}),
  }))

  app.delete<{ Params: { pid: string; iid: string } }>(
    '/api/projects/:pid/team/:iid',
    async (req, reply) => {
      await teamService.disable(req.params.pid, req.params.iid)
      return reply.code(204).send()
    },
  )
}

