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

      const built = buildAgentContext({
        project: { id: project.value.id, name: project.value.name, workdir: project.value.workdir },
        effective: config,
        history: history.value,
        toolSchemas,
        limits: {
          rawWindow: platform.context.session.rawWindow,
          maxCharsPerMsg: platform.context.session.maxCharsPerMsg,
          maxPromptChars: platform.models.maxPromptChars,
        },
      })

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
      }): Promise<Result<'approved' | 'rejected'>> => {
        const created = await options.approvals.request({
          projectId: context.projectId,
          kind: request.kind,
          actor: context.instanceId,
          sessionId: context.sessionId,
          summary: request.summary,
          detail: request.detail,
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
        return decision
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
            roots,
            projectPolicy,
            signal: context.signal,
            requestApproval,
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
      return ok(undefined)
    },
  }
}
