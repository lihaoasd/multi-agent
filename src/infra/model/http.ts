import type { ModelId } from '../../ports/model'
import type { ModelProviderConfig } from '../../ports/model-config'
import { err, ok, type Result } from '../../shared/result'
import { sanitizeForError } from './redact'

export interface ProviderRequestOptions {
  readonly provider: ModelProviderConfig
  readonly modelId: ModelId
  readonly url: string
  readonly method?: 'GET' | 'POST'
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: unknown
  readonly signal: AbortSignal
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

function timeoutSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
}

/**
 * 统一出站请求：超时/网络错误/非 2xx 一律映射为 `ERR_MODEL`，
 * 且消息与 detail 中的密钥已脱敏（model-config.md §8 失败语义）。
 */
export async function requestStream(
  options: ProviderRequestOptions,
): Promise<Result<ReadableStream<Uint8Array>>> {
  const { provider, modelId, url, method = 'POST', headers, body, signal, timeoutMs, secrets = [] } = options
  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers: { ...jsonHeaders(), ...(headers ?? {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: timeoutSignal(signal, timeoutMs),
    })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return err('ERR_MODEL', `请求供应商失败：${sanitizeForError(message, secrets)}`, {
      providerId: provider.id,
      modelId,
      url: sanitizeForError(url, secrets),
    })
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
  return ok(response.body)
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
