# 开发方案：任务栏（发布 → 通知领取 → 完成回通知委派人）· 2026-09-12

> 需求来源（用户口述）："修改逻辑，设计一个任务面板，项目经理和产品经理制定好任务，发布到任务栏，
> 并通知对应的角色领取任务，任务完成后更新任务栏的任务状态，并通知委派任务的人，做接下来的安排"

## 1. 现状（要改掉的逻辑）

- `task_assign`（pm/product）创建任务后**默认直接置 `in_progress` 并唤醒**受派人——没有"领取"这一步，角色被动开工。
- 任务只存在于右栏一个**只读小列表**（最多 12 条），没有状态分组，看不到"待领取/委派人/时间"。
- 任务状态变化**没有 WS 推送**，靠面板轮询，任务完成后委派人（pm/product）**完全不知道**——不会安排下一步。
- 槽位释放时 `promoteNext()` **静默自动开工**下一个 todo，同样绕过了"领取"。

## 2. 新流程（发布 → 领取 → 完成 → 回通知）

```
pm/product（或用户/会议纪要）
      │ task_assign / POST /tasks / minutes→tasks
      ▼
  ┌─ 任务栏（tasks.jsonl） ────────────────────────────────┐
  │  待领取(todo) → 进行中(in_progress) → 已完成(done)      │
  │                    ↘ 受阻(blocked) / 已终止(terminated) │
  └───────────────────────────────────────────────────────┘
      │ ① 发布即通知：向 u_<assignee> 注入系统消息 + 唤醒一轮
      │    「【系统】任务栏有新任务待你领取 t_x「…」…请调用 task_claim 领取」
      ▼
   受派人 task_claim（可省略 taskId = 领取最早一条）→ in_progress（槽位检查）
      │
      ▼
   受派人干活 → task_update(state=done|blocked|terminated)
      │ ② 状态变化 → WS task.updated（任务栏实时刷新）
      │ ③ 回通知委派人：向 u_<creator> 注入系统消息 + 唤醒一轮
      │    「【系统】你发布的任务 t_x「…」已由 dev_1 完成；请据此安排后续」
      ▼
   委派人安排下一步（验收 / 派新任务 / 发起会议）
```

要点：

- **`todo` 语义 = 已发布待领取**（不再等于"排队等平台自动开工"）；**领取 = todo → in_progress，只能由受派人本人发起**。
- 槽位被占用时 `task_claim` 返回 `ERR_CONFLICT`（不静默排队开工）；槽位释放后平台**通知**（而非自动开工）下一位待领取任务的受派人。
- 通知都是**系统消息 + 唤醒一轮**（`sendUserMessage(text,{system:true})`），与会话里其它平台提示一致，不冒充用户发言。
- 委派人 = `creator`；若 creator 是 `user`（老板），不做 agent 唤醒，由任务栏 + WS toast 通知。

## 3. 改动范围

### A. `TaskService`（`src/application/task/task-service.ts`）

- 构造函数改为 hooks 对象（唯一构造点=组合根，测试不直接构造）：
  ```ts
  new TaskService(projectsRoot, assignByAgent, {
    notifyClaim,      // (pid, assignee, task) => 通知领取
    notifyDelegator,  // (pid, task, event:'done'|'blocked'|'terminated', by) => 通知委派人
    settle,           // 既有：done/terminated 前结算 code 改动
    bus,              // WS task.updated
  })
  ```
- `create()`：落盘(todo) → `bus.emit('task.updated', {action:'published'})` → `notifyClaim()`（失败不抛）。
  → **四个入口（工具/JSON 文本/HTTP/纪要转出）自动统一"发布即通知"**。
- 新增 `claim(pid, actor, taskId?)`：`taskId` 缺省取该 actor 最旧的 `todo`；校验 `actor === assignee`（否则 `ERR_CONFLICT：只能领取派给自己的任务`）；已在 in_progress 幂等返回；槽位检查后置 `in_progress`；emit `task.updated`。
- `setState()`：
  - `assertActor` 收紧为 **user / 受派人本人 / 委派人(creator) / 甲模式下协调者(pm·product)**；
  - 每次变更 emit `task.updated`；
  - `done|terminated` → settle → `notifyDelegator('done'|'terminated')` → `notifyNextQueued()`（通知，不自动开工）；
  - `blocked` → `notifyDelegator('blocked')`。
- `promoteNext()` → `notifyNextQueued()`：只写通知，不改状态。

### B. `task-dispatch.ts`

- 去掉"创建后立即开工"；`assignTaskFromIntent` 只做 create（+ 工具审计），结果文案改为
  `📤 任务 t_x「…」已发布到任务栏 → dev_1（已通知领取）`。
- `TaskDispatchIntent` 去掉 `start`（JSON 里多余字段本就忽略）；`dispatchNoteFromResults` 同步文案。

### C. 工具（`service-tools.ts`）

- `task_assign`：描述改为"把任务**发布到任务栏**并通知受派人领取"；不再有"立即开工"表述。
- 新增 **`task_claim`**（platform / user 会话 / 任意角色可用，进了 `PLATFORM_USER_TOOLS`）：
  `task_claim{ taskId? }` → `tasks.claim(env.projectId, env.instanceId, taskId)`；无待领取任务时返回明确原因。
- `task_update` 保留（开工/完成/受阻/回队/终止），描述补一句"完成后平台会通知委派人安排后续"。

### D. 系统提示（`loop-runner.ts`）

- 新增 `toolRuntime.pendingTasks(ctx)` 钩子 → 注入 **`[待领取任务]`** 块（列出 id/标题/说明 + "调用 task_claim 领取；暂时不接就 task_update 置 blocked/todo 并说明"）。
- `[当前任务]` 块补一句"完成后平台通知委派人安排下一步"。
- `[任务分派]` 块（pm/product）改为"任务先**发布到任务栏**，平台通知受派人领取；对方领取后才开工"，示例去掉 `start`。

### E. 任务面板（前端）

- 右栏「任务」：状态计数徽标 + 紧凑列表（标题 → 受派人）+「任务栏」按钮。
- 新增 **任务栏弹窗 `#task-board`**：按状态分组（待领取 / 进行中 / 已完成 / 受阻 / 已终止），卡片显示
  标题、受派人、委派人、更新时间、说明；顶部统计。**只读**（状态由角色维护，用户不点完成/终止）。
- WS `task.updated` → 合并刷新面板；`done|blocked` 时 toast 提示（用户作为委派人时的"通知"）。

### F. 测试 / 文档

- 更新 `tests/think-dispatch-m8f.test.ts`（发布/通知/领取语义）、`tests/tasks-m8b.test.ts`（槽位释放=通知而非开工）。
- 新增 `tests/task-board-m8m.test.ts`：发布即通知（受派人会话出现系统消息）、`claim`（带/不带 taskId、非受派人拒绝、忙时拒绝、幂等）、`done` → 委派人会话收到通知 + WS `task.updated`、`blocked` → 通知、槽位释放 → 通知下一位。
- 文档：本方案 + `docs/changes/2026-09-12-task-board.md`、README、`docs/design/*`（tools 表、agent-runtime 提示块、data-storage 任务语义）、`docs/api/contract.md`（`task.updated`）。

## 4. 验证

- `npx tsc -p tsconfig.json` / `npx eslint .` / `npx vitest run --pool=threads` 全绿。
- 真实网络冒烟：起 `dist` 服务 + 真实 WS 客户端，走"发布 → 收到 task.updated + 通知消息 → claim → done → 委派人会话出现通知"。
- 手工：真实模型下 product 派单 → dev 会话收到"待领取"系统消息并调用 task_claim → 任务栏变"进行中" → done 后 product 被唤醒安排下一步。

## 5. 边界（本轮不做）

- 不做"任务抢占/转派"；不做任务依赖（DAG）；不做超时未领取自动提醒（任务栏可见"待领取"即可）。
- 用户仍不在 UI 上点完成/终止（状态由角色维护）；用户可 `POST/PATCH /tasks` 干预（保留接口）。
- 会议纪要转任务沿用同一 `create()`，因此同样"发布即通知"。
