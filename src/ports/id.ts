/**
 * id 生成（端口化以便测试注入确定性 id）。
 * 约定：`<prefix>_<base36 时间><随机后缀>`，如 `p_1a2b3c4d`；前缀全库统一，见各聚合定义。
 */
export interface IdGenerator {
  next(prefix: string): string
}
