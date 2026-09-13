# 开发方案：「完整系统提示词」实时预览 · 2026-09-13

> 需求来源（用户追问 + 确认）："提示词是完整提示词吗" → 澄清后用户选择
> **「新增『完整系统提示词预览』（实时拼）」**。

## 1. 现状与问题

- 角色详情弹窗里显示的 `prompt` 只是 `project.json` 的 `team[].prompt`（实例快照），
  而**真正发给模型的系统提示词**由 `AgentLoopRunner.buildSystemPrompt`（private）在每回合开始时拼装：
  实例提示词 → `[场景设定]` → `[执行模式]` → `回复要求` → `[可用工具]` → `[我的/他人产出物]` →
  `[当前任务]` → `[待领取任务]` → `[任务栏现状]`（甲模式 pm/product）→ `[团队成员]` → `[任务栏（甲模式已开启）]`。
- 后 10 段**不入库、随状态实时变化**（任务、产出物归属、会议/会话类型），界面上完全看不到；
  用户无法判断"我看到的提示词"和"模型收到的提示词"差在哪。
- 该拼装逻辑是类内私有方法，外部（HTTP 查询）无法复用；直接抄一份必然漂移。

## 2. 设计

### 2.1 拼装逻辑抽成纯函数单点（新增 `application/agent-loop/system-prompt.ts`）

把 `buildSystemPrompt` / `buildTeamRoster` / `buildDispatchHint` 与相关类型（`ActiveTask` /
`PendingTask` / `BoardTask` / `FileOwnership`）从 loop-runner 迁到新模块；loop-runner 变为
**调用方 + 类型 re-export**（`export type { ... } from './system-prompt.js'`，既有 import 路径不变）。

```ts
export function buildSystemPromptBlocks(input: SystemPromptInput): PromptBlock[]
export function buildSystemPrompt(input: SystemPromptInput): string // = blocks.map(b => b.text).join('\n')
export function isDispatchEligible(input): boolean // 甲模式分派是否生效（单点）
export const DISPATCH_ROLES = new Set(['pm', 'product'])
```

- `PromptBlock = { id, origin: 'role-config' | 'platform', title, text }`：
  **运行期只用 `buildSystemPrompt`（拼串，逐字节与改造前一致）**，预览接口用 blocks 逐段标注来源。
- 段间仍用 `'\n'` 连接；实例提示词段 text 末尾自带一个 `'\n'`，等价于原先的空行分隔
  （保证 `buildSystemPrompt` 输出与改造前完全一致——由既有用例 + 新增用例共同回归）。
- `dispatchEligible` 从 loop-runner 私有方法改为调用单点 `isDispatchEligible({taskDispatchEnabled, sessionType, roleTemplateId})`。

### 2.2 预览服务函数（`composition.previewSystemPrompt`）

组合根里已有全部运行时钩子（`activeTaskOf` / `pendingTasks` / `boardTasks` / `fileOwnership` / `listTools`），
因此预览**直接复用这些钩子**，不另写一套读取逻辑：

```ts
previewSystemPrompt(pid, iid) -> { sessionType: 'user', blocks, text } | null   // null = 实例不存在
// ctx = { projectId, sessionId: `u_${iid}`, member, scenario: 项目名, assignableMembers: 启用成员 }
// tools = toolRuntime.listTools(ctx, 'user')；任务/归属取实时值
```

预览按 **user 会话**（左栏角色行的主会话）拼装；会议会话的第 5 段工具集不同（只读），文档与界面注明。

### 2.3 接口与界面

- 新增 `GET /api/projects/:pid/agents/:iid/system-prompt` → `{ preview: { sessionType, blocks, text } }`；
  实例不存在 → 404 `ERR_NOT_FOUND`。
- 角色详情弹窗「提示词」区加一个按钮**「查看完整系统提示词」**（懒加载，点开才请求）：
  逐段渲染（段名 + 来源徽标「角色配置 / 平台注入」+ 全文），底部一句说明"后 10 段随任务/产出物实时变化；
  会议会话的工具段不同"。

## 3. 改动范围

| 文件                                          | 改动                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/application/agent-loop/system-prompt.ts` | 新增：拼装单点（blocks + string + 分派判定）                                                 |
| `src/application/agent-loop/loop-runner.ts`   | 删除搬迁的私有方法与类型声明；改调 `buildSystemPrompt`；类型 re-export                       |
| `src/application/composition.ts`              | 新增 `previewSystemPrompt`（`Services` 成员），复用既有运行时钩子                            |
| `src/server/app.ts`                           | 新增 `GET /api/projects/:pid/agents/:iid/system-prompt`                                      |
| `web/app.js` / `web/style.css`                | 弹窗里「查看完整系统提示词」按钮 + 分段渲染                                                  |
| `tests/system-prompt-preview-m9f.test.ts`     | 新增用例（见 §4）                                                                            |
| `tests/static-web-m8k.test.ts`                | 加 1 例：预览入口接线                                                                        |
| 文档                                          | 本方案 + `docs/changes/2026-09-13-system-prompt-preview.md` + contract/README/frontend-style |

## 4. 验证

- `npm run typecheck` / `lint` / `test`（全量，含既有提示词相关用例：think-dispatch、team-status、
  workdir-ownership、meeting-yield 等，作为"运行期提示词未变"的回归网）/ `build` 全绿。
- 新用例：
  ① 预览首段 = 实例提示词（与 `/agents/:iid` 的 `prompt` 一致），且 `text` = 各段按 `\n` 拼接；
  ② 含 `[场景设定]/[执行模式]/回复要求`，工具段名 = `/agents/:iid` 的 `effective` 工具名
  （`pm` 的预览里没有 `workdir_edit`，`dev` 有）；
  ③ 有 in_progress 任务 → 含 `[当前任务]` 与"收尾三件套"；有 todo 任务 → 含 `[待领取任务]`；
  ④ `pm` + `TASK__ASSIGN_BY_AGENT=true` → 含 `[任务栏现状]` 与 `[任务栏（甲模式已开启）]`；`dev` 不含；
  ⑤ `workdir_edit` 写入产生归属后 → 含 `[我的产出物（可改）]`，他人写入 → 含 `[他人产出物（只读…）]`；
  ⑥ 实例不存在 → 404。

## 5. 边界（本轮不做）

- 只预览 **user 会话**（会议会话预览入口不做；会议内的工具段差异在界面上以文字说明）。
- 不预览"历史消息窗口"（`buildHistory`，那是会话内容而非提示词）。
- 预览是**只读快照**：每次打开按钮重新请求，不落盘、不缓存、不参与运行期。
