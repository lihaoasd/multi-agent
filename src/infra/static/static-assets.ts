import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { StaticAssetProvider } from '../../ports/static-assets'

/**
 * 前端构建产物定位：按候选路径顺序取第一个存在的目录；都没有则返回 null（server 只提供 API）。
 * 候选形如 `web/dist`；路径相对 cwd 解析，且结果缓存（一次进程内不变）。
 */
export function createStaticAssetProvider(
  candidates: readonly string[],
  cwd: string = process.cwd(),
): StaticAssetProvider {
  let cached: string | null | undefined
  return {
    distDir(): string | null {
      if (cached !== undefined) return cached
      cached =
        candidates
          .map((candidate) => resolve(cwd, candidate))
          .find((candidate) => {
            try {
              return existsSync(candidate) && statSync(candidate).isDirectory()
            } catch {
              return false
            }
          }) ?? null
      return cached
    },
  }
}
