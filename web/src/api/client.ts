/** 统一 REST 客户端：错误体 `{code,message,detail?}` 转成 ApiError（contract.md §1/§4） */

export interface ApiErrorBody {
  readonly code: string
  readonly message: string
  readonly detail?: Readonly<Record<string, unknown>>
}

export class ApiError extends Error {
  readonly code: string
  readonly detail?: Readonly<Record<string, unknown>>

  constructor(body: ApiErrorBody) {
    super(body.message)
    this.name = 'ApiError'
    this.code = body.code
    this.detail = body.detail
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  )
}

export function describeError(cause: unknown): string {
  if (cause instanceof ApiError) return `${cause.code}：${cause.message}`
  if (cause instanceof Error) return cause.message
  return String(cause)
}

/** 从 detail.referrers 提取引用者文案（删除/停用被拒时展示） */
export function referrerLabels(detail: Readonly<Record<string, unknown>> | undefined): string[] {
  const raw = detail?.['referrers']
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => {
      if (typeof item !== 'object' || item === null) return null
      const record = item as Record<string, unknown>
      const kind = typeof record['kind'] === 'string' ? record['kind'] : '引用'
      const label = typeof record['label'] === 'string' ? record['label'] : String(record['id'] ?? '')
      return `${kind}:${label}`
    })
    .filter((item): item is string => item !== null)
}

export async function apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  const text = await response.text()
  let parsed: unknown = undefined
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
  }

  if (!response.ok) {
    throw new ApiError(
      isApiErrorBody(parsed) ? parsed : { code: `HTTP_${response.status}`, message: text || response.statusText },
    )
  }
  return parsed as T
}
