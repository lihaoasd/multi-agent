# 2026-09-12 任务撞车去重（pm / product 同时派同一件事）

## 需求/问题

用户："项目经理和产品经理派发任务冲突，会同时委派相同任务，这个解决方案推荐" → 确认按 **A.
同题跳过 + 回执提示 + force 逃生阀** 实现。

根因（详见 `docs/plan/2026-09-12-task-dedup.md`）：① 跨管理者无去重；② 两位管理者互相看不到对方发布的任务；
③ `tasks.jsonl` 的「读全量→改→覆盖写」无锁，并发发布会**静默丢任务**。

## 改动范围

### 一、服务层幂等（`src/application/task/task-service.ts`）

- **单项目串行锁** `withLock(projectId, fn)`：包住 `create` / `claim` / `setState` / `linkArtifact` 的
  「读-校验-写」；**锁内不做通知/结算**（通知会触发 Agent 回合，持锁会自锁）——`setState` 现在是
  "锁内写 + 锁外 settle/通知/广播"。
- `create()` 返回类型改为 `CreateTaskResult { task, duplicate }`，并在锁内做**同题去重**：
  同 `assignee` + 归一化标题相同（`normalizeTitle()`：去空白/标点/符号 + 小写）+ 状态 ∈ `{todo, in_progress}`
  → 不新建，返回既有任务（`duplicate: true`）。终态任务不参与去重（做完可再派）。`PublishOptions.force` 跳过检查。
- 四个入口（`task_assign` 工具 / 回复 JSON / `POST /tasks` / 会议纪要转任务）共用同一套逻辑。

### 二、提示层共享视野（`loop-runner.ts` + `composition.ts`）

- 新增 `toolRuntime.boardTasks(ctx)` 钩子 → 仅对 **pm/product** 注入 **`[任务栏现状]`**：
  列出 `todo/in_progress` 任务（id、标题、受派人、发布者、状态）+ "同一受派人的同一件事不要重复发布"。
- `[任务栏（甲模式已开启）]` 派单指引补第 4 条（发布前先看任务栏现状）。

### 三、回执与接口

- `task_assign` 工具：新增 `force` 参数；命中去重时回执
  `未重复创建：「X」→ dev_1 已有同题任务 t_…（由 pm_1 发布，状态 todo）…确需再派一条时用 force=true`。
- 文本入口：`【系统 · 任务栏】` 新增 `♻️ …本次未重复创建` 行；JSON 意图支持 `force`。
- `POST /api/projects/:pid/tasks`：支持 `force`；重复发布返回 **200 `{task, duplicate:true}`**（新建仍 201）。

### 四、测试

新增 `tests/task-dedup-m8n.test.ts`（8 例）：

1. 同题同受派人（工具入口）→ 只留一条 + 回执点名先发布者；
2. 标题归一化（空格/标点差异）算同题；不同受派人各留一条；
3. `force` 强制重复；终态后可再派；
4. **并发发不同任务 → 两条都在**（锁生效，不丢写）；
5. **并发发同题 → 只建一条**（检查在锁内）；
6. 文本入口回执 + JSON `force`；
7. HTTP 入口 `201/200 + duplicate`；
8. `[任务栏现状]` 只注入 pm/product（受派人无此块）。

另更新 `tests/think-dispatch-m8f.test.ts`（意图新增 `force` 字段断言）。

## 验证结果

- `npx tsc -p tsconfig.json` → 0；`npx eslint .` → 0
- `npx vitest run --pool=threads` → **27 文件 / 165 用例全绿**
- 真实网络冒烟（`node dist` + 真实服务与工具调用）：
  ```
  ① pm  → 已发布任务 t_x「实现贪吃蛇核心玩法」到任务栏 → dev_1（待领取；已通知 dev_1 领取）
     product → 未重复创建：「实现贪吃蛇核心玩法」→ dev_1 已有同题任务 t_x（由 pm_1 发布，状态 todo）…
     任务栏条数 → 1
  ② HTTP 并发发两条不同任务 → 201 201；任务栏 3 条（无丢写）
  ③ force → 已发布任务 t_y…；任务栏条数 → 4
  ```

## 语义变更（需知悉）

| 项 | 旧 | 新 |
| --- | --- | --- |
| 同题重复发布 | 静默新建第二条 | 自动去重，返回既有任务 + 明确回执 |
| 并发发布 | 可能互相覆盖丢任务 | 单项目串行锁，串行写入 |
| 管理者视野 | 只看得到成员名单 | 注入 `[任务栏现状]`（含对方发布的任务） |
| 强制重复 | 无 | `force=true`（工具/JSON/HTTP） |

## 边界（本轮不做）

- 语义级去重（同义改写识别）不做；不做描述合并（用户选 A，需要时用 `force` 或会话对齐）。
- 不做任务依赖（DAG）/抢占/转派；未领取超时提醒仍未做。
