/**
 * 路径边界判定（纯函数，domain 层）。
 *
 * 为什么放 domain：`isPathInside` 是**纯字符串/路径运算**，不含任何 IO，
 * 却是"虚拟路径是否越界"这一领域规则的基础。此前它住在 `infra/file-store/fs-utils.ts`，
 * 导致 `domain/rules/path-resolver.ts` 反向依赖 infra（P2 修正的分层违规）。
 *
 * 方向因此是：**domain 定义规则 → infra 复用**（`fs-utils` 从本文件导入）。
 */
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { AppError, ErrorCodes } from '../../shared/errors.js'

/**
 * 判断 target 是否位于 root 内（或等于 root）。两者均需为绝对路径。
 *
 * 说明：domain 允许使用 `node:path` 的**纯字符串运算**——它不是 IO，也不需要端口抽象；
 * 真正禁止的是 `node:fs`（读写）。这条口径写在 eslint 分层规则里。
 */
export function isPathInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

/**
 * 将候选路径约束在 root 之内；越界抛 ERR_FORBIDDEN_PATH。
 * root 可为文件或目录。用于一切写路径，防止目录穿越/越界写。
 */
export function ensureInside(root: string, candidate: string, what = 'path'): string {
  const absRoot = resolve(root)
  const absTarget = resolve(candidate)
  if (!isPathInside(absRoot, absTarget)) {
    throw new AppError(ErrorCodes.FORBIDDEN_PATH, `路径越界：${what} 不在允许范围内 (${absTarget})`)
  }
  return absTarget
}
