import type { Clock } from '../../ports/clock'
import type { ConfigProvider } from '../../ports/config'
import type { IdGenerator } from '../../ports/id'
import type { LockManager } from '../../ports/lock'
import type { Logger } from '../../ports/logger'
import type { ChatMessage, ModelGateway } from '../../ports/model'
import type { ProjectId } from '../../ports/project'
import type { MemoryService } from '../../ports/memory'
import type { SessionId, StoredEvent } from '../../ports/session'
import type { SessionService } from '../session/session-service'
import { ok, toAppErrorFrom, type Result } from '../../shared/result'
import { DEFAULT_SUMMARY_TRIGGER_MESSAGES, SUMMARY_PROMPT_CHARS } from '../../shared/loop'

/**
 * L2 滚动摘要引擎（memory.md §3.1）：
 * 把"超过阈值且尚未摘要"的会话消息窗口交给模型产出结构化摘要，写为会话 log 的 `summary` 事件。
 * **可重放派生视图**：`ofSeq/toSeq` 连续无重叠，重复调用只处理新窗口（幂等）。
 */

export interface SummaryDigest {
  readonly topic: string | null
  readonly goals: readonly string[]
  readonly decisions: readonly string[]
  readonly facts: readonly string[]
  readonly todos: readonly string[]
  readonly questions: readonly string[]
  /** 模型未按 JSON 返回时的退化文本 */
  readonly text: string | null
}

export type SummarySkipReason = 'below-threshold' | 'no-messages' | 'no-model' | 'model-failed'

export interface SummaryOutcome {
  readonly summarized: boolean
  readonly reason: SummarySkipReason | null
  readonly summaryId: string | null
  readonly ofSeq: number | null
  readonly toSeq: number | null
  readonly coveredMessages: number
  readonly memoryEntryId: string | null
}

export interface SummaryEngine {
  /** 回合结束后调用：达到阈值才摘要（不足阈值不调模型） */
  maintain(
    projectId: ProjectId,
    sessionId: SessionId,
    options?: { readonly turn?: number },
  ): Promise<Result<SummaryOutcome>>
}

export interface SummaryEngineOptions {
  /** 走 SessionService 写入：保证"先落盘、后推送"（EventPipeline 是唯一咽喉） */
  readonly sessions: SessionService
  readonly memory: MemoryService
  readonly gateway: ModelGateway
  /** 该实例的有效模型 id（由组合根注入 team.effectiveConfig 的读取） */
  readonly resolveModel: (projectId: ProjectId, instanceId: string) => Promise<Result<string | null>>
  readonly lock: LockManager
  readonly ids: IdGenerator
  readonly clock: Clock
  readonly config: ConfigProvider
  readonly logger: Logger
}

function skipped(reason: SummarySkipReason): SummaryOutcome {
  return {
    summarized: false,
    reason,
    summaryId: null,
    ofSeq: null,
    toSeq: null,
    coveredMessages: 0,
    memoryEntryId: null,
  }
}

function textOfEvent(event: StoredEvent): string | null {
  const direct = event.payload['text']
  if (typeof direct === 'string') return direct
  const content = event.payload['content']
  if (typeof content === 'object' && content !== null) {
    const text = (content as Record<string, unknown>)['text']
    if (typeof text === 'string') return text
  }
  return null
}

function roleOfEvent(event: StoredEvent): 'user' | 'agent' | null {
  const role = event.payload['role']
  if (role === 'user' || role === 'agent') return role
  return null
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0)
}

function extractJson(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function toDigest(raw: string): SummaryDigest {
  const parsed = extractJson(raw)
  const topic = parsed === null ? null : parsed['topic'] ?? parsed['主题']
  return {
    topic: typeof topic === 'string' && topic.trim().length > 0 ? topic.trim() : null,
    goals: parsed === null ? [] : readStringArray(parsed['goals'] ?? parsed['目标']),
    decisions: parsed === null ? [] : readStringArray(parsed['decisions'] ?? parsed['已定结论']),
    facts: parsed === null ? [] : readStringArray(parsed['facts'] ?? parsed['关键信息']),
    todos: parsed === null ? [] : readStringArray(parsed['todos'] ?? parsed['待办']),
    questions: parsed === null ? [] : readStringArray(parsed['questions'] ?? parsed['未决问题']),
    text: parsed === null ? raw.trim().slice(0, 1_500) : null,
  }
}

/** 摘要条目（写入角色记忆的 progress 条目）的文本形态 */
export function digestToText(digest: SummaryDigest): string {
  const parts: string[] = []
  if (digest.topic !== null) parts.push(`主题：${digest.topic}`)
  if (digest.decisions.length > 0) parts.push(`已定结论：${digest.decisions.join('；')}`)
  if (digest.facts.length > 0) parts.push(`关键信息：${digest.facts.join('；')}`)
  if (digest.todos.length > 0) parts.push(`待办：${digest.todos.join('；')}`)
  if (digest.questions.length > 0) parts.push(`未决问题：${digest.questions.join('；')}`)
  if (parts.length === 0) parts.push(digest.text ?? '（无可摘要内容）')
  return parts.join('\n')
}

export function createSummaryEngine(options: SummaryEngineOptions): SummaryEngine {
  const platform = options.config.get()
  const trigger = DEFAULT_SUMMARY_TRIGGER_MESSAGES

  const callModel = async (modelId: string, messages: readonly ChatMessage[]): Promise<Result<string>> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), platform.models.requestTimeoutMs)
    try {
      const streamed = await options.gateway.stream({ model: modelId, messages, signal: controller.signal })
      if (!streamed.ok) return streamed
      let text = ''
      for await (const chunk of streamed.value) {
        if (chunk.type === 'text-delta') text += chunk.text
      }
      return ok(text)
    } catch (cause) {
      return { ok: false as const, error: toAppErrorFrom(cause, 'ERR_MODEL') }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async maintain(projectId, sessionId, runOptions): Promise<Result<SummaryOutcome>> {
      // 同一会话串行维护：避免并发回合产出重叠摘要
      return options.lock.withLock(`summary:${sessionId}`, async (): Promise<Result<SummaryOutcome>> => {
        const meta = await options.sessions.get(projectId, sessionId)
        if (!meta.ok) return meta

        const history = await options.sessions.window(projectId, sessionId)
        if (!history.ok) return history
        const events = history.value

        let lastToSeq = 0
        for (const event of events) {
          if (event.kind !== 'summary') continue
          const toSeq = event.payload['toSeq']
          if (typeof toSeq === 'number' && Number.isFinite(toSeq)) lastToSeq = Math.max(lastToSeq, toSeq)
        }

        const pending = events.filter((event) => {
          if (event.kind !== 'message' || event.seq <= lastToSeq) return false
          const role = roleOfEvent(event)
          if (role === null) return false
          const text = textOfEvent(event)
          return text !== null && text.trim().length > 0
        })
        if (pending.length === 0) return ok(skipped('no-messages'))
        if (pending.length < trigger) return ok(skipped('below-threshold'))

        const window = pending.slice(0, trigger)
        const first = window[0]
        const last = window[window.length - 1]
        if (first === undefined || last === undefined) return ok(skipped('no-messages'))

        const instanceId = meta.value.participants.agents[0] ?? sessionId.replace(/^u_/, '')
        const modelId = await options.resolveModel(projectId, instanceId)
        if (!modelId.ok) return modelId
        if (modelId.value === null) return ok(skipped('no-model'))

        const transcript = window
          .map((event) => {
            const role = roleOfEvent(event) === 'user' ? '用户' : 'Agent'
            const text = (textOfEvent(event) ?? '').slice(0, platform.context.session.maxCharsPerMsg)
            return `${role}：${text}`
          })
          .join('\n')
          .slice(0, SUMMARY_PROMPT_CHARS)

        const messages: readonly ChatMessage[] = [
          {
            role: 'system',
            content:
              '你是会话摘要器。把对话压缩为结构化要点，只输出 JSON：' +
              '{"topic":"主题","goals":["目标"],"decisions":["已定结论"],"facts":["关键信息"],' +
              '"todos":["待办"],"questions":["未决问题"]}。每项最多 5 条，简洁、中文。',
          },
          { role: 'user', content: `请摘要以下对话片段（seq ${first.seq}~${last.seq}）：\n${transcript}` },
        ]

        const generated = await callModel(modelId.value, messages)
        if (!generated.ok) {
          options.logger.warn('滚动摘要模型调用失败', {
            projectId,
            sessionId,
            code: generated.error.code,
            message: generated.error.message,
          })
          return ok(skipped('model-failed'))
        }

        const digest = toDigest(generated.value)
        const summaryId = options.ids.next('sum')
        const appended = await options.sessions.append(projectId, sessionId, [
          {
            kind: 'summary',
            turn: runOptions?.turn ?? last.turn,
            payload: {
              summaryId,
              ofSeq: first.seq,
              toSeq: last.seq,
              digest,
              model: modelId.value,
              coveredMessages: window.length,
            },
          },
        ])
        if (!appended.ok) return appended

        // L3：引擎自动提取一条"进度"角色记忆（memory.md §4，可追溯到摘要窗口）
        const remembered = await options.memory.appendOwn({
          projectId,
          instanceId,
          sessionId,
          seq: last.seq,
          type: 'progress',
          content: digestToText(digest),
          tags: ['summary'],
          refs: [summaryId],
        })

        return ok({
          summarized: true,
          reason: null,
          summaryId,
          ofSeq: first.seq,
          toSeq: last.seq,
          coveredMessages: window.length,
          memoryEntryId: remembered.ok ? remembered.value.id : null,
        })
      })
    },
  }
}
