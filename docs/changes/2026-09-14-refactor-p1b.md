# 修改记录 · 重构 P1b：剩余 store 迁移（application 层 IO 基本归零）

> 日期：2026-09-14 · 阶段：P1b（`docs/plan/2026-09-14-refactor-architecture.md` 的 P1 后半）
> 类型：纯重构（**无业务行为改动**、无 REST/WS 契约变化、无数据格式变化）

## 需求/问题

P1a 落地了存储抽象并迁移 7 个 store。P1b 继续把剩下的持久化 store 从"自己读写文件/自己加锁"
改为"声明项目相对路径 + 注入门面"，目标是 `application/` 层的持久化 IO 归零。

## 改动范围

| 文件 | 现状 IO | 迁移方式 |
| --- | --- | --- |
| `application/approval/approval-service.ts` | 6 | `readAll` + `mutate`（整表重写） |
| `application/search/search-service.ts` | 5 | `list` + `readAll` + `writeText`（倒排索引 JSON） |
| `application/question/question-service.ts` | 5 | `readAll` + `mutate` |
| `application/task/task-service.ts` | 5 | 删自建 `KeyedLock`，`mutate` 承担读-改-写（含 `claim`/`create`/`setState`/`linkArtifact`） |
| `application/project/project-service.ts` | 15 | `readJson`/`writeJson`/`ensureDir`/`exists`/`removeDir`/`list` |
| `application/session/session-store.ts` | 10 | `readJson`/`writeJson`/`append`/`readAll`/`list`/`ensureDir` |
| `src/infra/store/project-store.ts` | — | 新增能力：`list` / `readText` / `writeText` / `exists` / `ensureDir` / `removeDir` |
| `tests/helpers.ts` | — | 新增 `makeStoreForProjectsRoot()`（3 处测试装配复用） |

## 关键实现

### 1. 门面能力按"真实需要"增长，而不是按想象

迁移中逐个暴露缺什么，才补什么（避免抽象先行）：

| 新增能力 | 触发它的真实调用点 |
| --- | --- |
| `list` | `search-service` 扫 `memories/`、`session-store` 枚举 `<sid>.meta.json`、`project-service` 列项目目录 |
| `readText` / `writeText` | `search-service` 的倒排索引 `search-index/idx.json`（非 JSONL，不能塞进 `readAll`） |
| `exists` / `ensureDir` | `project-service` 建实例骨架目录（`workspaces/<iid>/`、`sessions/`）与幂等建 meta |
| `remove` / `removeDir` | `code-edit-store` 结算清空轨迹、`project-service` 删项目运行时目录 |

**反面案例（已避免）**：迁移 `project-service` 时我一度用 `writeText(..., '.keep', '')` 来"建目录"，
这会**污染数据目录并改变行为**；发现后改为给门面加 `ensureDir`。

### 2. `task-service`：把自建锁换成端口锁

迁移前它自己持有 `KeyedLock` + `rewrite()` 做「读全量 → 改 → 覆盖写」。
现在改用门面的 `mutate`（内部 `KeyedLock` 按文件路径串行），锁语义与"只包住读改写、
不跨越通知/结算"的既有约定完全一致：

- `create`：去重检查 + 写入在同一 `mutate` 内；命中重复返回 `null`（不写盘）
- `claim`：读-校验-写在同一 `mutate` 内；幂等（已 `in_progress`）返回 `null`（不写盘、不广播）
- `setState`：校验 + 状态写入在同一 `mutate` 内；通知/结算仍在 `mutate` 之外
- `linkArtifact`：同一 `mutate` 内合并 `artifactIds`

### 3. 兼容策略延续 P1a

门面按**调用时传入的 `projectId`** 解析作用域（`forProjectsRoot`），
因此 store 方法签名（`readAll(projectId, …)`）一行未改，调用点零改动。
测试只改装配行，断言未动。

## 验证结果

| 项 | 结果 |
| --- | --- |
| `npm run typecheck` | ✅ 无输出 |
| `npm run test`（全量） | ✅ **49 文件 / 315 用例**通过 |
| `npm run lint` | ✅ 0 error（棘轮 warning 未增加） |
| 排除 3 个时序敏感用例后 | ✅ **44 文件 / 291 用例**通过 |

### 关于耗时与偶发超时（如实记录）

本阶段全量耗时在 **21s → 31~39s** 之间波动，且 `minutes-plan-m8e`、`meeting-round-m6b`
两个**既有**用例在负载高时偶发 `Test timed out in 5000ms`：

- 两者单独运行均通过（连续 3 次全绿，2.8~6.0s）
- 排除这 3 个时序敏感用例后，全量稳定全绿
- 结论：这是**既有测试对并发负载敏感**，不是本轮改动引入的行为退化；
  本轮未修改测试超时配置（改测试基础设施属独立决策）

## 遗留（P1c 收尾 + 明确例外）

### A. 仍需迁移的 2 个

| 文件 | 说明 |
| --- | --- |
| `application/artifact/artifact-service.ts`（19 处） | manifest 可走门面，但 `execute`/`rollback`/`settleCodeAggregation` 是**工作目录文件拷贝与版本快照**，不属于键值存储；应新增**文件操作端口**（`FileOps`）承载，而不是硬塞进 `ProjectStore` |
| `application/roles/role-service.ts`（8 处） | 用户自建角色库位于 `<dataDir>/roles`，**不在项目作用域内**；需要独立的"全局作用域"门面或专用小端口 |

### B. 有意保留的直接文件访问（不是遗留，是例外）

| 文件 | 理由 |
| --- | --- |
| `application/fs-browse/fs-browse-service.ts` | 目录选择器：按定义就是在**用户任意目录**上列目录 |
| `application/export/export-service.ts` | 导出 zip：整目录打包，属导出功能本身 |
| `application/project/project-service.ts` 的 `detectWorkdirKind` | 扫**用户工作目录**判断是否空目录/既有仓库 |
| `application/tools/service-tools.ts` 的 `workdir_edit` | 写**项目工作目录**的交付物（生产路径，非运行时存储） |

> 这 4 处访问的都不是"项目运行时存储"，而是用户工作目录或任意目录，
> 把它们塞进 `ProjectStore` 才会真正扭曲抽象。P1c 会把这条例外写成注释/文档，供后续自查。
