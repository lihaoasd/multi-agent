# 2026-09-13 「完整系统提示词」实时预览

- 需求/问题（用户追问 + 确认）："提示词是完整提示词吗" → 用户选择
  **「新增『完整系统提示词预览』（实时拼）」**（含逐段标注来源）。
- 类型：feature（只读查询 + 界面折叠区）+ 重构（提示词拼装抽成单点，**运行期输出逐字节不变**）
- 改动范围：`application/agent-loop`、`application/composition.ts`、`server/app.ts`、`web/`、`tests/`

## 语义

角色详情弹窗的「提示词」区现在明确区分两层：

| 层             | 内容                                                                                                                                                | 来源                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 实例提示词     | `team[].prompt`（创建实例时的模板快照）                                                                                                             | 角色配置，入库、可查看（弹窗直接显示）   |
| 完整系统提示词 | 实例提示词 + `[场景设定]/[执行模式]/回复要求/[可用工具]/[我的·他人产出物]/[当前任务]/[待领取任务]/[任务栏现状]/[团队成员]/[任务栏（甲模式已开启）]` | 平台每回合按当时状态实时拼装，**不入库** |

- 弹窗里新增按钮**「查看完整系统提示词」**（懒加载，点开才请求）→ 逐段渲染：段名 + 来源徽标
  （`角色配置` / `平台注入`）+ 全文；底部注明"按 user 会话实时拼装、会议会话工具段不同、任务与归属会变"。
- 新接口 `GET /api/projects/:pid/agents/:iid/system-prompt` → `{ preview: { sessionType:'user', blocks, text } }`；
  实例不存在 → 404 `ERR_NOT_FOUND`。`blocks[] = { id, origin, title, text }`，`text` = 各段按 `\n` 拼接。

## 改动

- **新增 `src/application/agent-loop/system-prompt.ts`（提示词拼装单点）**：
  `buildSystemPromptBlocks(input)` / `buildSystemPrompt(input)`（= blocks 拼串）/ `isDispatchEligible()` /
  `DISPATCH_ROLES`，以及从 loop-runner 迁来的 `ActiveTask/PendingTask/BoardTask/FileOwnership` 类型。
  段文本**原样搬运**；实例提示词段末尾自带 `\n`（等价于原先的空行分隔），保证拼串结果与改造前逐字节一致。
- `src/application/agent-loop/loop-runner.ts`：删除已迁走的三个私有方法与类型声明，改调 `buildSystemPrompt`；
  类型经 `export type { ... } from './system-prompt.js'` 保持既有 import 路径可用；
  `dispatchEligible` 改为调用单点 `isDispatchEligible`。**运行期行为不变**。
- `src/application/composition.ts`：新增 `Services.previewSystemPrompt(pid, iid)`——**复用运行期同一批钩子**
  （`listTools`/`activeTask`/`pendingTasks`/`boardTasks`/`fileOwnership`）按 user 会话（`u_<iid>`）实时拼一遍；
  实例不存在返回 `null`。`taskDispatch` 与 toolRuntime 的装配顺序不变（预览函数定义在两者之后）。
- `src/server/app.ts`：新增预览路由（404 映射）。
- `web/app.js` / `web/style.css`：`loadFullSystemPrompt` 懒加载 + 分段渲染 + 来源徽标样式；提示词区补说明文案。
- `tests/system-prompt-preview-m9f.test.ts`（新增 6 例）+ `tests/static-web-m8k.test.ts`（+1 例接线断言）。

## 验证

- `npm run typecheck` / `lint` / `build` 全绿；`npm run test` → **46 files / 257 tests passed**。
  其中 think-dispatch / team-status / workdir-ownership / meeting-yield 等**既有提示词断言用例全部通过**，
  即"抽单点后运行期提示词未变"的回归证据。
- 新增 `tests/system-prompt-preview-m9f.test.ts`：
  ① 段序固定（第 1 段 `instance-prompt`/`role-config`，其余 `platform`）、`text` = 各段拼接、
  含 `[场景设定]（项目名）`/`[执行模式]`/`回复要求`/`[团队成员]`；
  ② 工具段的**工具名清单**与 `/agents/:iid` 的 `effective` 逐名相同；`pm` 无 `workdir_edit`/`cmd_run`；
  ③ `in_progress` → `[当前任务]`（含收尾三件套）、`todo` → `[待领取任务]`；pm 无任务时两段都不出现；
  ④ 甲模式（`TASK__ASSIGN_BY_AGENT=true`）：pm 有 `[任务栏现状]` 与 `[任务栏（甲模式已开启）]`，dev 没有；
  ⑤ `workdir_edit` 写入产生归属后：本人见 `[我的产出物（可改）]`，他人见 `[他人产出物（只读…）]`；
  ⑥ 实例不存在 → 404。
- 真实数据冒烟（对当前 `data/projects` 里的项目跑 dist 产物）：`architect_1` 返回 6 段
  （1 段角色配置 + 5 段平台注入），工具段首行与会话实际工具一致（该角色暂无任务/产出物，故对应段不出现）。

## 已知边界

- 预览只按 **user 会话**拼装（会议会话的工具段是只读子集，界面上以文字说明，不做切换）。
- 不预览历史消息窗口（`buildHistory`）——那是会话内容不是提示词；预览不落盘、不缓存。
- **工具段的模板句固定提到 `cmd_run`**（"运行命令用 cmd_run…"），即使该角色没有该工具也会出现该句——
  这是改造前就有的提示词文案，本次只做搬迁未改内容（测试因此只断言"工具名清单"部分）。
- 上一轮《角色详情》方案 §5 里"不展示注入后的完整系统提示词"的边界，已由本轮实现覆盖。
