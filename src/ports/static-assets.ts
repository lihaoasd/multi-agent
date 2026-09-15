/**
 * 前端静态资源（server 不直接读盘，走本端口；见 abstraction.md §2 server 层依赖禁令）。
 * 未构建前端时返回 null，server 仅提供 API。
 */
export interface StaticAssetProvider {
  distDir(): string | null
}
