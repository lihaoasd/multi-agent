import type { ModelId } from '../../ports/model'
import type { ModelProviderConfig } from '../../ports/model-config'
import { err, ok, type Result } from '../../shared/result'
import { sanitizeForError } from './redact'

/**
 * 出站请求的**超时口径（S52/D55）**：`timeoutMs` 是**空闲超时**——"多久没有数据到达就算失败"，
 * **不是**整个请求的总时长上限。
 *
 * 为什么改：原先用 `AbortSignal.timeout(timeoutMs)` 挂在 fetch 上，它是**从发起时刻算的固定截止**，
 * 于是"边想边写、总时长超过 60 秒"的正常输出会被硬砍，报错正是
 * `模型流式响应中断：The operation was aborted due to timeout`（真实事故：写 20~35KB 设计文档的
 * 回合被 60s 截止砍掉，还白白重试 3 次）。现在：响应头有独立截止，**响应体只受空闲看门狗约束**，
 * 只要数据在流就永远不会超时。
 */
export interface ProviderRequestOptions {
  readonly provider: ModelProviderConfig
  readonly modelId: ModelId
  readonly url: string
  readonly method?: 'GET' | 'POST'
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: unknown
  readonly signal: AbortSignal
  /** **空闲超时**（毫秒）：多久没有数据到达就中止；不是总时长上限 */
  readonly timeoutMs: number
  /** 用于错误信息脱敏的密钥值 */
  readonly secrets?: readonly (string | null | undefined)[]
}

/** 组装认证/通用请求头（各 kind 差异在此收敛） */
export function jsonHeaders(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { 'content-type': 'application/json', accept: 'application/json', ...extra }
}

function seconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))} 秒`
}

/**
 * 给响应体套一层**空闲看门狗**：每次读取都重置计时；超过 `timeoutMs` 没有数据到达就触发 `onIdle`。
 * 数据持续到达时**不设总时长上限**（长输出不再被砍）。
 */
function withIdleWatchdog(
  body: ReadableStream<Uint8Array>,
  onIdle: () => void,
  timeoutMs: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let idleFired = false
  const idleError = (): Error =>
    new Error(`模型流式响应空闲超时：${seconds(timeoutMs)}没有数据到达（可在「模型 → 供应商」调大超时）`)
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      const timer = setTimeout(() => {
        idleFired = true
        onIdle() // 中止底层请求（真实 fetch 会让 read 以 AbortError 失败）
        void reader.cancel().catch(() => undefined) // 兜底：让"卡住的 read"立即结束
      }, timeoutMs)
      try {
        const { done, value } = await reader.read()
        if (done) {
          // 两条路径都收敛到同一个可读错误：真实请求是 read 抛错；被 cancel 的流是 done
          if (idleFired) controller.error(idleError())
          else controller.close()
          return
        }
        if (value !== undefined) controller.enqueue(value)
      } catch (cause) {
        // 空闲超时时给出可读原因（而不是底层的 "The operation was aborted"）
        controller.error(idleFired ? idleError() : cause)
      } finally {
        clearTimeout(timer)
      }
    },
    cancel(reason): void {
      void reader.cancel(reason)
    },
  })
}

/**
 * 统一出站请求：超时/网络错误/非 2xx 一律映射为 `ERR_MODEL`，
 * 且消息与 detail 中的密钥已脱敏（model-config.md §8 失败语义）。
 */
export async function requestStream(
  options: ProviderRequestOptions,
): Promise<Result<ReadableStream<Uint8Array>>> {
  const { provider, modelId, url, method = 'POST', headers, body, signal, timeoutMs, secrets = [] } = options
  // 空闲看门狗（响应体阶段）与"响应头截止"（连接阶段）分开：前者可被数据重置，后者只约束拿到响应头
  const idle = new AbortController()
  const headerDeadline = new AbortController()
  let headerTimedOut = false
  const headerTimer = setTimeout(() => {
    headerTimedOut = true
    headerDeadline.abort()
  }, timeoutMs)
  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers: { ...jsonHeaders(), ...(headers ?? {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, idle.signal, headerDeadline.signal]),
    })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    if (headerTimedOut) {
      return err('ERR_MODEL', `模型请求超时：${seconds(timeoutMs)}内没有拿到响应（可在「模型 → 供应商」调大超时）`, {
        providerId: provider.id,
        modelId,
        url: sanitizeForError(url, secrets),
      })
    }
    return err('ERR_MODEL', `请求供应商失败：${sanitizeForError(message, secrets)}`, {
      providerId: provider.id,
      modelId,
      url: sanitizeForError(url, secrets),
    })
  } finally {
    // 响应头到手（或已失败）就撤掉连接截止：**响应体只受空闲看门狗约束**
    clearTimeout(headerTimer)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return err('ERR_MODEL', `供应商返回 HTTP ${response.status}`, {
      providerId: provider.id,
      modelId,
      status: response.status,
      body: sanitizeForError(text, secrets),
    })
  }

  if (response.body === null) {
    return err('ERR_MODEL', '供应商返回空响应体', { providerId: provider.id, modelId })
  }
  return ok(withIdleWatchdog(response.body, () => idle.abort(), timeoutMs))
}

/** 非流式 GET/POST（用于 listModels / test） */
export async function requestJson(
  options: ProviderRequestOptions,
): Promise<Result<unknown>> {
  const streamed = await requestStream(options)
  if (!streamed.ok) return streamed
  const reader = streamed.value.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) text += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return ok(JSON.parse(text))
  } catch {
    return err('ERR_MODEL', '供应商响应不是合法 JSON', {
      providerId: options.provider.id,
      modelId: options.modelId,
      body: sanitizeForError(text, options.secrets ?? []),
    })
  }
}
