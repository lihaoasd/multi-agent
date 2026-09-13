/**
 * 文件操作端口（重构 P1c，2026-09-14）。
 *
 * 与 `storage.ts` 的分工：
 *   · `storage.ts` 管**项目运行时存储**（JSONL/JSON 记录：会话日志、任务、审批…），寻址=项目相对路径。
 *   · 本文件管**真实文件内容搬运**：工作目录交付物拷贝、版本快照、哈希/大小。
 *     这些操作的对象是"用户工作目录里的源码文件"，既不是运行时记录，
 *     也不受项目相对路径约束（`workdir` 在项目外），所以单独成端口。
 *
 * 为什么需要它：`ArtifactService` 迁移前直接用 `node:fs` 做
 * `copyFile`/`mkdir`/`readFile`（提交=写入工作目录 + 快照到 `artifact-versions/`），
 * 这属于 infrastructure 细节；把它塞进 `ProjectStore` 会扭曲"记录存储"的语义，
 * 因此单列一个薄的 `FileOps` 端口，由 `infra/store` 实现。
 */

/** 文件快照信息（内容哈希 + 字节数）。 */
export interface FileFingerprint {
  hash: string
  size: number
}

/** 真实文件操作（绝对路径；调用方负责路径边界校验）。 */
export interface FileOps {
  /** 读文件为 Buffer（不存在 → 抛错）。 */
  read(absPath: string): Promise<Buffer>
  /** 读文件为文本（不存在 → 抛错）。 */
  readText(absPath: string): Promise<string>
  /** 写文本（自动建父目录，原子写）。 */
  writeText(absPath: string, text: string): Promise<void>
  /** 拷贝文件（自动建目标父目录）。 */
  copy(from: string, to: string): Promise<void>
  /** 建目录（递归）。 */
  ensureDir(absDir: string): Promise<void>
  /** 文件是否存在。 */
  exists(absPath: string): Promise<boolean>
  /** 列目录内容（不存在 → []）。 */
  list(absDir: string): Promise<string[]>
  /** 删除目录（递归，不存在静默成功）。 */
  removeDir(absDir: string): Promise<void>
  /** 内容指纹：sha256 + 字节数。 */
  fingerprint(absPath: string): Promise<FileFingerprint>
}
