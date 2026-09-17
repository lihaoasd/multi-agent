import { BASE_TOOL_PACKAGES } from '../../shared/loop'

/**
 * 基础工具包「全员必装」规则（S25，纯函数）：**8 个基础包是地板，不是可选项**。
 *
 * 为什么要有这条规则：`packages` 以前只是"模板 yaml 里写对 + 创建实例时照抄"的**约定**，
 * 任何一处漏写（旧模板、旧项目实例快照、手工改过的 `data/roles/*.yaml`）都不会被发现。
 * 因此在读/写两侧统一归一：
 * - 基础 8 包永远在最前（顺序稳定，便于比较与展示）；
 * - 模板额外声明的包（如未来的自定义包）保留在后；
 * - 去重；未知 id 不丢（前向兼容，校验另在需要处做）。
 */
export function normalizePackages(declared: readonly string[]): readonly string[] {
  const extras: string[] = []
  for (const id of declared) {
    if (BASE_TOOL_PACKAGES.includes(id as (typeof BASE_TOOL_PACKAGES)[number])) continue
    if (extras.includes(id)) continue
    extras.push(id)
  }
  return [...BASE_TOOL_PACKAGES, ...extras]
}

/** 缺哪些基础包（为空 = 合规）；用于断言、日志与需要报错的场景 */
export function missingBasePackages(declared: readonly string[]): readonly string[] {
  return BASE_TOOL_PACKAGES.filter((id) => !declared.includes(id))
}
