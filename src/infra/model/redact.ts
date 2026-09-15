/**
 * 密钥脱敏（model-config.md §5）：任何出站/入站文本在进入日志、错误体、审计、接口响应之前
 * 都必须先过这里。策略：① 已知密钥值精确替换；② 常见键名前缀兜底规则。
 */
const SECRET_KEY_PATTERNS: readonly RegExp[] = [
  /\b(sk-|rk-|ak-)[A-Za-z0-9._-]{6,}/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]{6,}=*/gi,
  /(x-api-key|x-goog-api-key|api[_-]?key|apikey|access[_-]?token|authorization)["'\s:=]+[A-Za-z0-9._~+/-]{6,}=*/gi,
  /([?&](?:key|api_key|access_token)=)[A-Za-z0-9._~+/-]{6,}/gi,
]

export function redactSecrets(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  let output = text
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 6) continue
    output = output.split(secret).join('***')
  }
  for (const pattern of SECRET_KEY_PATTERNS) {
    output = output.replace(pattern, (_match, prefix: string | undefined) =>
      typeof prefix === 'string' && prefix.length > 0 ? `${prefix}***` : '***',
    )
  }
  return output
}

export function truncate(text: string, max = 400): string {
  return text.length <= max ? text : `${text.slice(0, max)}…(+${text.length - max} 字符)`
}

/** 组装可直接放进错误 detail / 日志的脱敏片段 */
export function sanitizeForError(
  text: string,
  secrets: readonly (string | null | undefined)[] = [],
  max = 400,
): string {
  return truncate(redactSecrets(text, secrets), max)
}
