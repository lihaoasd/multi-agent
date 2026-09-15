import type { Clock } from '../../ports/clock'
import type { ConfigProvider } from '../../ports/config'
import type { EventBroadcaster } from '../../ports/events'
import type { Logger } from '../../ports/logger'
import type { ChatMessage, ModelChunk, ToolSchema } from '../../ports/model'
import type { ModelGateway } from '../../ports/model'
import type { ProjectStore } from '../../ports/project'
import type { ToolCall } from '../../ports/tools'
import type { TurnRunContext, TurnRunner } from '../../ports/turn'
import type { ApprovalService } from '../approval/approval-service'
import type { MemoryService } from '../../ports/memory'
import type { SearchService } from '../../ports/search'
import type { TaskService } from '../../ports/task'
import type { QuestionService } from '../../ports/question'
import type { SummaryEngine } from '../memory/summary-engine'
import type { SessionService } from '../session/session-service'
import type { TeamService } from '../team/team-service'
import { AppFailure, err, ok, toAppErrorFrom, type Result } from '../../shared/result'
import { buildAgentContext } from './context-builder'
import type { LoopRegistry, LoopRunEnv, ModelTurnResult } from './loop'
import type { ToolExecutor } from '../tools/tool-executor'
import type { ToolRegistry } from '../../ports/tools'

export interface AgentLoopRunnerOptions {
  readonly projects: ProjectStore
  readonly team: TeamService
  readonly sessions: SessionService
  readonly loops: LoopRegistry
  readonly gateway: ModelGateway
  readonly tools: ToolRegistry
  readonly toolExecutor: ToolExecutor
  readonly approvals: ApprovalService
  /** L3 记忆：上下文注入（读）与摘要引擎回写（写） */
  readonly memory: MemoryService
  /** 检索：按用户消息取"已在窗口之外"的相关片段注入（memory.md §5） */
  readonly search: SearchService
  /** L2 滚动摘要引擎：回合结束后按阈值维护 */
  readonly summary: SummaryEngine
  /** 任务：上下文注入 + 产出物按任务聚合归属（D14-⑧/D19-⑤） */
  readonly tasks: TaskService
  /** 询问桥：`ask_user` 落 pending 并等待用户答复（D19-⑦） */
  readonly questions: QuestionService
  /** 产出物清单（`file-owners`）注入系统提示：我的/他人产出物（§2.2） */
  readonly artifacts: import('../../ports/artifact').ArtifactService
  readonly broadcaster: EventBroadcaster
  readonly config: ConfigProvider
  readonly clock: Clock
  readonly logger: Logger
}

const MODEL_RETRY_LIMIT = 3

/** 真实回合执行器（S4）：组装上下文 → 按策略执行 → 事件落盘由 dispatcher 的 emit 保证 */
export function createAgentLoopRunner(options: AgentLoopRunnerOptions): TurnRunner {
  const platform = options.config.get()

  const callModelWithRetry = async (
    request: {
      readonly messages: readonly ChatMessage[]
      readonly tools?: readonly ToolSchema[]
      readonly modelOverride?: string
      readonly purpose: string
    },
    modelId: string | null,
    signal: AbortSignal,
    notify: (chunk: ModelChunk) => void,
  ): Promise<Result<ModelTurnResult>> => {
    if (modelId === null) {
      return err('ERR_MODEL', '该角色还没有可用模型：请在「模型」模块添加供应商与模型条目')
    }

    let lastError: { code: string; message: string } | null = null
    for (let attempt = 1; attempt <= MODEL_RETRY_LIMIT; attempt += 1) {
      try {
        const streamed = await options.gateway.stream({
          model: modelId,
          messages: request.messages,
          ...(request.tools === undefined || request.tools.length === 0 ? {} : { tools: request.tools }),
          signal,
        })
        if (!streamed.ok) {
          lastError = { code: streamed.error.code, message: streamed.error.message }
        } else {
          let text = ''
          let reasoning = ''
          const toolCalls: ToolCall[] = []
          for await (const chunk of streamed.value) {
            if (chunk.type === 'text-delta') {
              text += chunk.text
              notify(chunk)
            } else if (chunk.type === 'reasoning-delta') {
              reasoning += chunk.text
            } else if (chunk.type === 'tool-call') {
              toolCalls.push({ callId: chunk.callId, name: chunk.name, args: chunk.args })
            }
          }
          return ok({ text, reasoning, toolCalls, modelId })
        }
      } catch (cause) {
        const appError = cause instanceof AppFailure ? cause.appError : toAppErrorFrom(cause, 'ERR_MODEL')
        lastError = { code: appError.code, message: appError.message }
      }
      if (signal.aborted) break
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt))
    }

    return err('ERR_MODEL', `模型调用失败（已重试 ${MODEL_RETRY_LIMIT} 次）：${lastError?.message ?? '未知错误'}`, {
      modelId,
      code: lastError?.code,
    })
  }

  return {
    async runTurn(context: TurnRunContext): Promise<Result<void>> {
      const project = await options.projects.get(context.projectId)
      if (!project.ok) return project

      const effective = await options.team.effectiveConfig(context.projectId, context.instanceId)
      if (!effective.ok) return effective
      const config = effective.value

      const projectPolicy = {
        highRiskCommands: project.value.approvalPolicy.highRiskCommands,
        docSubmitApproval: project.value.artifactPolicy.docSubmitApproval,
        codeSubmitApproval: project.value.artifactPolicy.codeSubmitApproval,
        network: platform.sandbox.network,
      }

      const roots = {
        workdir: project.value.workdir,
        runtime: `${process.cwd()}/data/projects/${project.value.id}`.replace(/\\/g, '/'),
        readonly: [`${process.cwd()}/src/shared`.replace(/\\/g, '/')],
      }

      const history = await options.sessions.history(context.projectId, context.sessionId, undefined, {
        limit: platform.context.session.rawWindow,
      })
      if (!history.ok) return history

      const toolNames = config.tools.length > 0 ? config.tools : options.tools.list().map((item) => item.name)
      const toolSchemas = options.tools.schemasFor(toolNames, context.sessionType)

      // L3：激活记忆条目（global + 本人角色，上限取 contextLimits）
      const memories = await options.memory.activeFor(context.projectId, context.instanceId)
      // 检索注入：只补充"不在本次窗口内"的片段，避免与 session-window 重复
      const windowKeys = new Set(history.value.map((event) => `${event.sessionId}#${event.seq}`))
      const retrieved = await options.search.search({
        projectId: context.projectId,
        query: context.userText,
        viewer: { kind: 'agent', instanceId: context.instanceId },
        limit: Math.max(platform.context.search.maxSnippets, 1),
      })
      const snippets = retrieved.ok
        ? retrieved.value.filter((hit) => hit.sessionId === null || !windowKeys.has(`${hit.sessionId}#${hit.seq}`))
        : []

      // 任务上下文（D19-⑤/D17-①）：只注入"进行中"的任务；todo 不入上下文
      const activeTask = await options.tasks.activeFor(context.projectId, context.instanceId)
      // 产出物索引与署名（workspaces-artifacts §2.2）：我的（可改）/ 他人的（只读）
      const owners = await options.artifacts.listOwners(context.projectId)
      const myOwners = owners.ok ? owners.value.filter((item) => item.owner === context.instanceId) : []
      const otherOwners = owners.ok ? owners.value.filter((item) => item.owner !== context.instanceId) : []
      const artifactList = await options.artifacts.list(context.projectId, { limit: 10 })

      const built = buildAgentContext({
        project: { id: project.value.id, name: project.value.name, workdir: project.value.workdir },
        effective: config,
        history: history.value,
        toolSchemas,
        memories: memories.ok ? memories.value : [],
        snippets,
        ...(activeTask.ok && activeTask.value !== null ? { task: activeTask.value } : {}),
        ownership: { mine: myOwners, others: otherOwners },
        artifacts: artifactList.ok ? artifactList.value : [],
        limits: {
          rawWindow: platform.context.session.rawWindow,
          maxCharsPerMsg: platform.context.session.maxCharsPerMsg,
          maxPromptChars: platform.models.maxPromptChars,
          maxSnippets: platform.context.search.maxSnippets,
        },
      })
      const sourceSeq = history.value[history.value.length - 1]?.seq ?? 0

      const strategyName = config.loop.strategy
      const strategy = options.loops.get(strategyName)
      if (strategy === undefined) {
        return err('ERR_VALIDATION', `未注册的 loop 策略：${strategyName}`, {
          available: options.loops.list().map((item) => item.name),
        })
      }

      const params = config.loop.params as { maxIterations?: number; toolBudget?: number; stepModelOverride?: string }
      let toolUsed = 0
      const budget = {
        used: () => toolUsed,
        spend: (count = 1) => {
          toolUsed += count
        },
      }

      const requestApproval = async (request: {
        readonly kind: 'command' | 'submit' | 'rollback'
        readonly summary: string
        readonly detail: string
      }): Promise<Result<{ readonly decision: 'approved' | 'rejected'; readonly approvalId: string | null }>> => {
        const created = await options.approvals.request({
          projectId: context.projectId,
          kind: request.kind,
          actor: context.instanceId,
          sessionId: context.sessionId,
          summary: request.summary,
          detail: request.detail,
          // doc 类提交审批的只读预览引用（D16-⑥，规则 16）：先给"待批动作"的说明文本
          ...(request.kind === 'submit' ? { previewRef: `approval-preview://${context.sessionId}/${context.turn}` } : {}),
        })
        if (!created.ok) return created
        await context.emit({
          kind: 'approval_request',
          turn: context.turn,
          payload: {
            approvalId: created.value.id,
            kind: created.value.kind,
            summary: created.value.summary,
            risk: request.kind === 'command' ? 'high' : 'low',
            detail: created.value.detail,
            previewRef: created.value.previewRef,
          },
        })
        const decision = await options.approvals.waitForDecision(context.projectId, created.value.id, context.signal)
        await context.emit({
          kind: 'approval_result',
          turn: context.turn,
          payload: {
            approvalId: created.value.id,
            decision: decision.ok ? decision.value : 'rejected',
            reason: decision.ok ? null : decision.error.message,
          },
        })
        if (!decision.ok) return decision
        return ok({ decision: decision.value, approvalId: created.value.id })
      }

      /** 询问桥（D19-⑦）：落 pending → 广播 → 阻塞等待答复；答复或回合取消都会返回 */
      const askUser = async (request: {
        readonly title: string
        readonly items: readonly {
          readonly text: string
          readonly options?: readonly string[]
          readonly required?: boolean
        }[]
      }): Promise<
        Result<{
          readonly questionId: string
          readonly answers: readonly { readonly itemId: string; readonly choice: string | null; readonly text: string | null }[]
        }>
      > => {
        const asked = await options.questions.ask({
          projectId: context.projectId,
          sessionId: context.sessionId,
          asker: context.instanceId,
          title: request.title,
          items: request.items,
        })
        if (!asked.ok) return asked
        const answered = await options.questions.waitForAnswer(context.projectId, asked.value.id, context.signal)
        if (!answered.ok) return answered
        return ok({ questionId: asked.value.id, answers: answered.value.answer?.answers ?? [] })
      }

      const callModel = (request: {
        readonly messages: readonly ChatMessage[]
        readonly tools?: readonly ToolSchema[]
        readonly modelOverride?: string
        readonly purpose: string
      }): Promise<Result<ModelTurnResult>> =>
        callModelWithRetry(
          request,
          request.modelOverride ?? config.model,
          context.signal,
          (chunk) => {
            if (chunk.type !== 'text-delta') return
            options.broadcaster.broadcast({
              type: 'message.chunk',
              payload: { projectId: context.projectId, sessionId: context.sessionId, turn: context.turn, delta: chunk.text },
            })
          },
        )

      const env: LoopRunEnv = {
        projectId: context.projectId,
        sessionId: context.sessionId,
        instanceId: context.instanceId,
        turn: context.turn,
        userText: context.userText,
        systemPrompt: config.systemPrompt,
        contextMessages: built.messages,
        history: history.value,
        toolSchemas,
        toolNames,
        maxIterations: params.maxIterations ?? (strategyName === 'plan-execute' ? 6 : 1),
        toolBudget: params.toolBudget ?? 30,
        ...(params.stepModelOverride === undefined ? {} : { stepModelOverride: params.stepModelOverride }),
        signal: context.signal,
        emit: context.emit,
        notify: (event) => options.broadcaster.broadcast(event),
        callModel,
        runTool: async (call) =>
          options.toolExecutor.execute(call, {
            projectId: context.projectId,
            instanceId: context.instanceId,
            sessionId: context.sessionId,
            sessionType: context.sessionType,
            turn: context.turn,
            sourceSeq,
            roots,
            projectPolicy,
            signal: context.signal,
            requestApproval,
            askUser,
          }),
        budget,
        shouldInterrupt: () => {
          if (context.signal.aborted) return true
          return false
        },
      }

      await context.emit({
        kind: 'turn_start',
        turn: context.turn,
        payload: { turnId: `turn_${context.turn}`, loopStep: strategyName, model: config.model },
      })

      const result = await strategy.run(env)
      if (!result.ok) {
        options.logger.warn('回合执行失败', {
          projectId: context.projectId,
          instanceId: context.instanceId,
          code: result.error.code,
          message: result.error.message,
        })
        await context.emit({
          kind: 'error',
          turn: context.turn,
          payload: { errorCode: result.error.code, message: result.error.message },
        })
        await context.emit({
          kind: 'message',
          turn: context.turn,
          payload: {
            role: 'agent',
            sender: context.instanceId,
            text: `执行失败：${result.error.message}`,
            content: { text: `执行失败：${result.error.message}` },
            model: config.model,
            loopStep: strategyName,
          },
        })
      }

      await context.emit({ kind: 'turn_end', turn: context.turn, payload: { ok: result.ok } })

      // L2 滚动摘要：回合结束后按阈值维护（不足阈值不调模型，失败不影响回合结果）
      const maintained = await options.summary.maintain(context.projectId, context.sessionId, {
        turn: context.turn,
      })
      if (!maintained.ok) {
        options.logger.warn('滚动摘要维护失败', {
          projectId: context.projectId,
          sessionId: context.sessionId,
          code: maintained.error.code,
          message: maintained.error.message,
        })
      }
      return ok(undefined)
    },
  }
}
