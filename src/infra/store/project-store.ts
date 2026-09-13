/**
 * 项目作用域存储门面（重构 P1，2026-09-14）。
 *
 * 用途：application 层的 store 只声明"相对路径"（如 `memories/global.jsonl`），
 * 不接触 `node:path` / `node:fs`；持久化细节全部收在 `infra/store`。
 *
 * **作用域如何确定**（这三种寻址必须与迁移前语义等价）：
 *   · `forProject(pid)`             —— 固定单个项目（生产路径）
 *   · `forProjectsRoot(projectsRoot)` —— 作用域 = `<projectsRoot>/<调用时传入的 projectId>`，
 *     等价于迁移前各 store 内部的 `join(projectsRoot, projectId, …)`
 *   · `forProjectAbs(绝对项目目录)`   —— 固定一个已存在的项目目录（既有测试场景）
 *
 * 之所以支持第二种：迁移前 store 的公开签名形如 `readAll(projectId, …)`，
 * 而 P1 的硬约束是"不改调用方"；门面因此在**同一实例**内按调用参数解析作用域。
 */
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

import { atomicWriteFile, dirExists } from '../file-store/fs-utils.js'
import type {
  JsonlStore,
  JsonStore,
  StoreScope,
  StoragePorts,
} from '../../ports/storage.js'
import { StorageRoot } from './storage-root.js'

/** 由"调用时传入的 projectId"解析出项目运行时绝对目录。 */
export type ScopeResolver = (projectId: string) => string

/** 单个项目作用域内的读写面。 */
export class ProjectStore {
  constructor(
    private readonly jsonl: JsonlStore,
    private readonly json: JsonStore,
    private readonly resolveBase: ScopeResolver,
  ) {}

  /** 项目运行时绝对目录（**单点**：读、写、`abs()` 都走这里）。 */
  baseDir(projectId: string): string {
    return this.resolveBase(projectId)
  }

  /** 逻辑地址：相对路径 → 端口作用域（含越界校验）。 */
  private at(projectId: string, relPath: string): StoreScope {
    const base = this.baseDir(projectId)
    // 不论哪种寻址模式都做越界校验（防 `..` 逃出项目运行时目录）
    this.guard(base, relPath)
    return { baseDir: base, relPath }
  }

  /** 越界校验（由子类/工厂注入具体校验器）。 */
  protected guard(base: string, relPath: string): void {
    void base
    void relPath
  }

  // ── JSONL ────────────────────────────────────────────────────────────────

  /** 读全部记录（坏行跳过；文件不存在 → []）。 */
  async readAll<T>(projectId: string, relPath: string): Promise<T[]> {
    return (await this.jsonl.readAll(this.at(projectId, relPath))) as T[]
  }

  /** 读尾部 n 条。 */
  async readTail<T>(projectId: string, relPath: string, n: number): Promise<T[]> {
    return (await this.jsonl.readTail(this.at(projectId, relPath), n)) as T[]
  }

  /** 追加一条。 */
  async append(projectId: string, relPath: string, record: unknown): Promise<void> {
    await this.jsonl.append(this.at(projectId, relPath), record)
  }

  /** 加锁的读-改-重写整文件。 */
  async mutate<T>(
    projectId: string,
    relPath: string,
    fn: (all: T[]) => T[] | null,
  ): Promise<T[]> {
    return (await this.jsonl.mutate(this.at(projectId, relPath), (all) =>
      fn(all as T[]),
    )) as T[]
  }

  // ── JSON ────────────────────────────────────────────────────────────────

  /** 读 JSON；不存在 → null；解析失败抛 ERR_INTERNAL。 */
  async readJson<T>(projectId: string, relPath: string): Promise<T | null> {
    return (await this.json.read(this.at(projectId, relPath))) as T | null
  }

  /** 原子写 JSON。 */
  async writeJson(projectId: string, relPath: string, value: unknown): Promise<void> {
    await this.json.write(this.at(projectId, relPath), value)
  }

  /** 加锁的读-改-写 JSON。 */
  async mutateJson<T>(
    projectId: string,
    relPath: string,
    fn: (cur: T | null) => T | null,
  ): Promise<T | null> {
    return (await this.json.mutate<T>(this.at(projectId, relPath), (cur) =>
      fn(cur as T | null),
    )) as T | null
  }

  /** 删除文件（不存在时静默成功）。用途：结算后清空轨迹这类"用删除表达状态"的记录。 */
  async remove(projectId: string, relPath: string): Promise<void> {
    await fs.rm(this.abs(projectId, relPath), { force: true }).catch(() => undefined)
  }

  // ── 目录 / 文本 ──────────────────────────────────────────────────────────

  /** 列出目录内文件名（不存在 → []）。 */
  async list(projectId: string, relPath = ''): Promise<string[]> {
    try {
      return await fs.readdir(this.abs(projectId, relPath))
    } catch {
      return []
    }
  }

  /** 读文本文件；不存在 → null。 */
  async readText(projectId: string, relPath: string): Promise<string | null> {
    try {
      return await fs.readFile(this.abs(projectId, relPath), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  /** 原子写文本文件（自动建目录）。 */
  async writeText(projectId: string, relPath: string, text: string): Promise<void> {
    await fs.mkdir(dirname(this.abs(projectId, relPath)), { recursive: true })
    await atomicWriteFile(this.abs(projectId, relPath), text)
  }

  /** 路径（文件或目录）是否存在。 */
  async exists(projectId: string, relPath: string): Promise<boolean> {
    return dirExists(this.abs(projectId, relPath))
  }

  /** 建目录（递归，已存在则无操作）。 */
  async ensureDir(projectId: string, relPath: string): Promise<void> {
    await fs.mkdir(this.abs(projectId, relPath), { recursive: true })
  }

  /** 递归删除目录/文件（不存在时静默成功）。用途：删除整个项目运行时目录。 */
  async removeDir(projectId: string, relPath = ''): Promise<void> {
    await fs.rm(this.abs(projectId, relPath), { recursive: true, force: true })
  }

  /** 项目运行时目录下的绝对路径（需与外部进程/工具交互时使用）。 */
  abs(projectId: string, relPath = ''): string {
    const base = this.baseDir(projectId)
    this.guard(base, relPath)
    return relPath ? join(base, relPath) : base
  }
}

/** 带越界校验的项目门面（由 StorageFacade 构造）。 */
class GuardedProjectStore extends ProjectStore {
  constructor(
    jsonl: JsonlStore,
    json: JsonStore,
    resolveBase: ScopeResolver,
    private readonly root: StorageRoot,
  ) {
    super(jsonl, json, resolveBase)
  }

  protected override guard(base: string, relPath: string): void {
    this.root.resolveRaw(base, relPath, base)
  }
}

/** 由存储端口派生项目作用域门面的工厂。 */
export class StorageFacade {
  constructor(
    private readonly ports: StoragePorts,
    private readonly root: StorageRoot,
  ) {}

  /** 生产路径：固定单个项目。 */
  forProject(projectId: string): ProjectStore {
    return new GuardedProjectStore(
      this.ports.jsonl,
      this.ports.json,
      () => this.root.projectDir(projectId),
      this.root,
    )
  }

  /** 兼容路径：作用域 = `<projectsRoot>/<调用时传入的 projectId>`（迁移前各 store 的语义）。 */
  forProjectsRoot(projectsRoot: string): ProjectStore {
    const rootedAt = this.root.reRoot(projectsRoot)
    return new GuardedProjectStore(
      this.ports.jsonl,
      this.ports.json,
      (projectId) => rootedAt.projectDir(projectId),
      rootedAt,
    )
  }

  /** 兼容路径：固定一个已存在的项目运行时目录（既有测试 `new XStore(项目目录)` 场景）。 */
  forProjectAbs(projectRuntimeDir: string): ProjectStore {
    return new GuardedProjectStore(
      this.ports.jsonl,
      this.ports.json,
      () => projectRuntimeDir,
      this.root.reRoot(projectRuntimeDir),
    )
  }
}
