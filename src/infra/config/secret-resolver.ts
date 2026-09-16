import type { Credential, SecretResolver } from '../../ports/model-config'
import { err, ok, type Result } from '../../shared/result'

/**
 * 凭证解析（model-config.md §5）：
 * - `file` 模式：明文存于 `data/model-config.json`（`data/` 不入库），直接返回；
 * - `env` 模式：只存变量名，值从进程环境读取（缺失即 ERR_VALIDATION，不等到调用才失败）。
 * 注意：**返回值只允许流向适配器**，不得进入日志、接口响应、审计或错误事件。
 */
export function createSecretResolver(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SecretResolver {
  const lookup = (envName: string): string | null => {
    const value = env[envName]
    return value !== undefined && value.trim().length > 0 ? value : null
  }

  return {
    resolve(credential: Credential): Result<string | null> {
      if (credential.mode === 'file') {
        // 空值允许：ollama 等本地后端本就不需要密钥；
        // 真实供应商的"必须有密钥"由**创建/编辑时**的校验保证（validate.ts §8 #5）。
        return ok(credential.value.length > 0 ? credential.value : null)
      }
      const value = lookup(credential.envName)
      if (value === null) {
        return err('ERR_VALIDATION', `环境变量 ${credential.envName} 不存在或为空`, {
          envName: credential.envName,
        })
      }
      return ok(value)
    },

    has(credential: Credential): boolean {
      return credential.mode === 'file' ? credential.value.length > 0 : lookup(credential.envName) !== null
    },
  }
}
