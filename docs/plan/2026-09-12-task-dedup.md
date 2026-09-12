# 开发方案：任务撞车去重（pm / product 同时派同一件事）· 2026-09-12

> 需求来源（用户反馈）："项目经理和产品经理派发任务冲突，会同时委派相同任务"
> 用户确认方案：**A. 同题跳过 + 回执提示 + force 逃生阀**

## 1. 根因（三个问题叠加）

1. **没有跨管理者去重**：`assignTaskFromIntent()` 只校验"受派人存在/不是自己"，不检查是否已有同题任务；
   `parseTaskIntents()` 的 `seen` 只在自己这一条回复内去重 → pm_1 与 product_1 各发一次就是两条记录。
2. **两位管理者互相看不见对方的发布**：pm/product 的系统提示只有 `[团队成员]` 名单，`[待领取任务]` 只给受派人
   → 两人都以为"这事没人派"。
3. **`tasks.jsonl` 是「读全量 → 改 → 覆盖写」且无锁**：两人几乎同时发布时后写者覆盖前写者 → **静默丢一条任务**
   （比重复更隐蔽）。

## 2. 方案（三层）

### A. 服务层幂等 —— 硬约束

- **单项目串行锁**：`TaskService.withLock(projectId, fn)`（异步 promise 链），包住 `create` / `claim` /
  `setState` / `linkArtifact` 的"读-校验-写"。**锁内不做通知/结算**（它们会触发 Agent 回合，持锁会自锁）。
- **同题去重**：`create()` 在锁内检查 —— 同 `assignee` + **归一化标题**相同（去空白/标点/符号 + 小写）
  + 状态 ∈ `{todo, in_progress}` → 不新建，返回既有任务（`{ task, duplicate: true }`）。
  终态（done/terminated）不参与去重 → 同一件事做完可以再派。
- **逃生阀**：`create(input, { force: true })` / 工具参数 `force` / JSON 意图 `force` → 跳过检查。

### B. 提示层共享视野 —— 软约束

- `toolRuntime.boardTasks(ctx)` → **`[任务栏现状]`** 块（仅 pm/product 的会话注入）：列出 `todo/in_progress`
  任务（id、标题、受派人、发布者、状态）+ "发布前先对照，同一受派人的同一件事不要重复发布"。
- `task_assign` 工具描述写明自动去重与 `force`；`[任务栏（甲模式已开启）]` 指引补第 4 条（先看任务栏现状）。

### C. 回执可观测

- 命中去重时回执点名"与谁发布的哪条重复、当前状态"，并提示"确需再派用 force=true"
  （工具入口 / 文本入口 `【系统 · 任务栏】♻️` / HTTP `200 {task, duplicate:true}`）。
- 任务栏卡片已显示 `受派人 ← 委派人`，撞车肉眼可见。

## 3. 改动范围

| 文件 | 改动 |
| --- | --- |
| `src/application/task/task-service.ts` | `withLock` 串行锁；`create()` 返回 `CreateTaskResult{task,duplicate}` + 同题去重 + `PublishOptions.force`；`claim/setState/linkArtifact` 改为锁内读改写、锁外通知；导出 `normalizeTitle()` |
| `src/application/task/task-dispatch.ts` | 意图支持 `force`；`DispatchItemResult` 增 `duplicate/existingCreator`；说明行新增 `♻️ 未重复创建` 分支 |
| `src/application/tools/service-tools.ts` | `task_assign` 增 `force` 参数 + 去重回执 + 描述（先看任务栏现状） |
| `src/application/agent-loop/loop-runner.ts` | 新增 `boardTasks` 钩子与 `[任务栏现状]` 提示块；派单指引补"不要重复发布" |
| `src/application/composition.ts` | 注入 `boardTasks`；纪要转任务适配 `create()` 新返回 |
| `src/server/app.ts` | `POST /tasks` 支持 `force`；重复发布返回 `200 {task, duplicate:true}`（新建 201） |
| `tests/task-dedup-m8n.test.ts` | 新增 8 例（见下） |

## 4. 验证

- 新增用例：同题去重（工具/文本/HTTP 三入口）、标题归一化、不同受派人允许、`force`、终态后可再派、
  **并发发不同任务不丢写**、**并发发同题只建一条**、`[任务栏现状]` 只注入管理者。
- 全量：`tsc` 0 / `eslint` 0 / `vitest` 27 文件 165 用例全绿。
- 真实网络冒烟（`node dist` + 真实服务/工具调用）：
  ```
  ① pm → 已发布任务 t_x「实现贪吃蛇核心玩法」到任务栏 → dev_1（待领取）
     product → 未重复创建：已有同题任务 t_x（由 pm_1 发布，状态 todo）…确需再派一条时用 force=true
     任务栏条数 → 1
  ② HTTP 并发发两条不同任务 → 201 201；任务栏 3 条（无丢写）
  ③ force → 已发布任务 t_y…；任务栏条数 → 4
  ```

## 5. 边界（本轮不做）

- 语义级去重（识别同义改写）：要模型判断，成本/不确定性高；归一化标题 + 共享视野覆盖绝大多数撞车。
- 不做"合并描述"（用户选 A）；如需补充说明，走会话对齐或 `force`。
- 不做任务依赖（DAG）/抢占/转派。
