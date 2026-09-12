# 2026-09-12 任务栏：发布 → 通知领取 → 完成回通知委派人

## 需求/问题

用户："修改逻辑，设计一个任务面板，项目经理和产品经理制定好任务，发布到任务栏，并通知对应的角色领取任务，
任务完成后更新任务栏的任务状态，并通知委派任务的人，做接下来的安排"

改造前的问题：

1. `task_assign` 创建任务后**直接置 in_progress 并唤醒**——没有"领取"，角色被动开工，委派人也不知道对方是否接单；
2. 任务面板只是一个**只读小列表**（最多 12 条），没有状态分组，看不到"待领取/委派人/时间"；
3. 任务状态变化**没有 WS 推送**（靠轮询）；
4. 任务完成/受阻后**委派人完全不知情**，不会安排下一步；
5. 槽位释放时 `promoteNext()` **静默自动开工**下一条，同样绕过领取。

## 改动范围

### 一、服务端：发布-领取制（`src/application/task/`）

- `task-service.ts`
  - 构造函数改为 hooks 对象（唯一构造点=组合根）：`{ notifyClaim, notifyDelegator, settle, bus }`。
  - `create()`：落盘 `state=todo`（语义=**已发布·待领取**）→ `bus.emit('task.updated', action:'published')` → `notifyClaim()`（通知受派人，失败静默）。
    → `task_assign` 工具 / 回复 JSON / `POST /tasks` / 会议纪要转任务**四个入口统一"发布即通知"**。
  - 新增 `claim(projectId, actor, taskId?)`：`taskId` 缺省=领取该受派人最旧的待领取任务；校验 `actor === assignee`（否则"不能领取"）；已 `in_progress` 幂等返回；`done/terminated` 拒绝；单工槽位被占 → `ERR_CONFLICT`；置 `in_progress` → 广播 `action:'claimed'`。
  - `setState()`：`assertActor` 收紧为 **user / 受派人本人 / 委派人(creator) /（甲模式下）协调者 pm·product（实例 id 前缀匹配 pm_/product_）**；每次变更广播 `task.updated`；`done|terminated` → 结算 code 改动 → **通知委派人** → 通知下一位待领取任务；`blocked` → 通知委派人。
  - `promoteNext()`（自动开工）→ `notifyNextQueued()`（**只通知**，状态保持 todo）。
- `task-dispatch.ts`：去掉"创建后立即开工"与 `start` 字段；说明行改为 `📤 任务 t_x「…」已发布到任务栏 → dev_1（待领取，已通知对方）`。
- `composition.ts`：注入两个通知钩子（**系统消息 + 唤醒一轮**，与会话内其它平台提示一致）；`task_claim` 加入 `PLATFORM_USER_TOOLS`；新增 `toolRuntime.pendingTasks` 供提示块使用。

### 二、系统提示（`loop-runner.ts`）

- 新增 **`[待领取任务]`** 块：列出任务栏上派给自己的待领取任务（id/标题/委派人/说明）+「调用 `task_claim` 领取；暂时接不了就 `task_update` 置 blocked 并说明」。
- `[当前任务]` 补一句"完成后平台会**通知委派人安排后续**"。
- `[任务栏（甲模式已开启）]`（pm/product）：发布任务到任务栏 + 明确"对方领取后才开工，不要承诺已经开工；对方完成/受阻时平台会通知你"。

### 三、工具（`service-tools.ts`）

- `task_assign`：描述/回执改为"发布到任务栏 + 通知领取"（受派人 claim 后才开工）。
- 新增 **`task_claim`**：领取任务栏上派给自己的任务（可带 `taskId`，缺省领最早一条）。
- `task_update`：描述补"平台会更新任务栏并通知委派人安排后续"。

### 四、任务栏面板（`web/`）

- 右栏「任务栏」：状态计数徽标（`N 待领取 / M 进行中`）+ 紧凑列表 + 「打开面板」按钮。
- 新增弹窗 `#task-board`：按状态分组（**待领取 / 进行中 / 受阻 / 已完成 / 已终止**）展示全部任务，卡片含标题、`受派人 ← 委派人`、更新时间、说明；顶部统计。**只读**（状态由角色领取/汇报，用户不点完成/终止）。
- WS `task.updated` → 合并刷新任务栏；完成/受阻/终止时 toast（用户作为委派人时的通知）。
- `style.css`：任务栏弹窗与卡片样式。

### 五、测试 / 文档

- 新增 `tests/task-board-m8m.test.ts`（4 例）：发布即通知 + `task.updated(published)`；`task_claim`（缺省领最早、非受派人拒、忙时拒、幂等）；完成 → 委派人收到"请据此安排后续" + `task.updated(done)`；受阻 → 通知委派人 + 槽位释放只再通知一次（任务保持 todo）。
- 更新：`tests/think-dispatch-m8f.test.ts`（发布语义/`start` 忽略/`【系统 · 任务栏】`/待领取通知）、`tests/tasks-m8b.test.ts`（槽位释放=通知而非开工 + `claim`）、`tests/static-web-m8k.test.ts`（任务栏面板接线守卫）。
- 文档：`docs/plan/2026-09-12-task-board-publish-claim.md`、本记录、`README.md`、`docs/api/contract.md`（`task.updated`）、`docs/design/tools.md`（工具表）、`docs/design/workspaces-artifacts.md`、`docs/design/agent-runtime.md`。

## 验证结果

- `npx tsc -p tsconfig.json` → 0；`npx eslint .` → 0；`node --check web/app.js` → 0
- `npx vitest run --pool=threads` → **26 文件 / 157 用例全绿**
- 真实网络冒烟（`tsc -p tsconfig.build.json` → `node dist` 起真实服务 + 真实 `ws` 客户端 + 真实工具调用）：
  ```
  ① 发布 → 已发布任务 t_…「实现贪吃蛇」到任务栏 → dev_1（待领取；已通知 dev_1 领取）
     WS task.updated → "todo"
  ② 受派人收到领取通知 → true
  ③ 领取 → 已领取任务 t_…「实现贪吃蛇」→ 进行中（in_progress）
  ④ 完成 → 任务 t_… 状态 → done ；WS task.updated(done) → yes ；委派人收到通知 → true
  ⑤ 任务栏终态 → 实现贪吃蛇:done
  ```

## 语义变更（需知悉）

| 项 | 旧 | 新 |
| --- | --- | --- |
| `todo` | 排队等平台自动开工 | **已发布·待领取** |
| 开工 | 平台自动置 in_progress | 受派人 `task_claim` 领取 |
| 槽位释放 | 自动开工下一条 | 只通知，等领取 |
| 任务状态变更 | 无推送 | WS `task.updated` |
| 完成/受阻 | 委派人不知情 | **通知委派人**（系统消息 + 唤醒） |
| 谁可改状态 | 甲模式下任意角色 | user / 受派人本人 / 委派人 /（甲模式）pm·product |

## 边界（本轮不做）

- 不做任务抢占/转派/依赖（DAG）；不做未领取超时提醒（任务栏可见"待领取"）。
- 用户在 UI 上仍不点完成/终止（状态由角色维护）；`POST/PATCH /tasks` 保留给用户/协调者干预。
- 前端面板已通过语法/静态接线检查与真实服务冒烟，但未做浏览器人工目视验收。
