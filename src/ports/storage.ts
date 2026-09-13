/**
 * 存储端口（重构 P1，2026-09-14）。
 *
 * 存在理由：重构前 **21 个文件**（其中 15 个 store）各自手写一遍
 * `readFile → split('\n') → JSON.parse`、各自 `atomicWriteFile`、各自加串行锁。
 * 本文件把"持久化"收成一个抽象，application 层只依赖这里的接口，
 * 具体实现（`infra/store/`）由组合根 `composition.ts` 注入 —— 对应
 * `docs/design/architecture.md` §4.1「核心端口清单」里的 `SessionLogStore` / `MemoryStore` / `FileStore`。
 *
 * 行为契约（迁移期必须逐条保持，否则既有 `data/` 数据与测试会回归）：
 * 1. **文件不存在 = 空集合**，不抛错（`readAll` 返回 `[]`）。
 * 2. **JSONL 坏行跳过**（data-storage.md §9 损坏容错），不因单行损坏丢整个文件。
 * 3. **JSON 解析失败要抛错**（meta 等结构化文件损坏属真故障，不能静默当空）。
 * 4. **写是原子的**（临时文件 + rename），读者永远看不到半截文件。
 * 5. `mutate` 的**读-改-写全程持锁**，并发调用不会互相覆盖。
 *
 * 寻址：端口只接受**绝对路径**。相对地址的解析与越界校验由上层门面
 * （`infra/store/project-store.ts` + `storage-root.ts`）完成，端口自身不做路径策略。
 */

/**
 * 存储作用域：一个已存在的（或允许创建的）目录 + 其中的相对路径。
 * 直接测端口时用它寻址；生产路径由 `StorageFacade` 构造。
 */
export interface StoreScope {
  /** 绝对目录（写入时按需创建） */
  baseDir: string
  /** 目录内相对路径；空串表示目录本身（用于列举） */
  relPath: string
}

/** 追加式 JSONL（会话日志、任务、审批、产出物归属这类"只追加"或"整体重写"的记录文件）。 */
export interface JsonlStore {
  /** 读全部记录（跳过坏行；文件不存在返回 []）。 */
  readAll(scope: StoreScope): Promise<unknown[]>
  /** 读尾部 n 条。 */
  readTail(scope: StoreScope, n: number): Promise<unknown[]>
  /** 追加一条（实现负责补换行）。 */
  append(scope: StoreScope, record: unknown): Promise<void>
  /**
   * 加锁的读-改-重写（整文件重写的 JSONL 记录，如归属表/审批表/任务表）：
   * `fn(all)` 返回
   *   · 非 null → 覆盖写回该数组（每行一条 JSON + 末尾换行）
   *   · null     → 不写，直接返回原数组
   * 迁移前各 store 自行 `lock.run + readAll + 拼行 + atomicWrite`，现在锁归实现层。
   */
  mutate(scope: StoreScope, fn: (all: unknown[]) => unknown[] | null): Promise<unknown[]>
}

/** 单文件 JSON（会话 meta、runtime.state.json、manifest 这类结构化状态）。 */
export interface JsonStore {
  /** 读；文件不存在返回 null；解析失败抛 ERR_INTERNAL。 */
  read(scope: StoreScope): Promise<unknown | null>
  /** 原子写（格式化 JSON + 末尾换行）。 */
  write(scope: StoreScope, value: unknown): Promise<void>
  /**
   * 加锁的读-改-写：`fn(current)` 返回
   *   · 非 null → 原子写回并返回它
   *   · null     → 不写，直接返回 current
   */
  mutate<T>(scope: StoreScope, fn: (current: unknown) => unknown | null): Promise<T>
}

/** 目录列举（会话文件枚举等）。 */
export interface DirectoryStore {
  /** 列出目录内文件名；目录不存在返回 []。 */
  list(scope: StoreScope): Promise<string[]>
}

/** 组合后的存储端口集（注入给各 store 的唯一边界）。 */
export interface StoragePorts {
  jsonl: JsonlStore
  json: JsonStore
  dir: DirectoryStore
}
