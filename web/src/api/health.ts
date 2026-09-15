/** 服务端健康检查（REST 契约见 docs/api/contract.md；此处为 S0 唯一调用） */

export interface HealthResponse {
  readonly status: string
  readonly name: string
  readonly version: string
  readonly uptimeMs: number
  readonly dataDir: string
  readonly sandboxNetwork: string
}

export interface ApiErrorBody {
  readonly code: string
  readonly message: string
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch('/health', { signal })
  if (!response.ok) {
    throw new Error(`健康检查失败：HTTP ${response.status}`)
  }
  return (await response.json()) as HealthResponse
}
