# 开发方案：角色详情（每个角色可查看提示词 / loop / 工具 / 状态）· 2026-09-13

> 需求来源（用户口述）："每个角色，可以查看他的详细消息，提示词，loop 是哪个，有什么工具等"
> 澄清结论（本轮问答定案）：
> ① "详细消息" = **角色详细信息（配置一览）**，不是会话消息/事件轨迹；
> ② 入口形式 = **左栏角色行「详情」按钮 → 只读弹窗**（不改动现有布局，无编辑能力）。

## 1. 现状与问题

- 左栏团队行（`web/app.js` `renderTeamNav`）只显示：显示名（实例 id）、状态徽标、「停用/启用」。
  角色配置（提示词 / loop / 工具 / 模型）只存在于 `project.json` 的 `team[]` 里，**界面上完全看不到**。
- 后端已有 `GET /api/projects/:pid/team`（原始实例配置）与 `GET /api/projects/:pid/agents`
  （实时状态投影），但**没有把两者合起来的角色详情视图**，前端也就无法一次拿到"这个角色到底怎么配的"。
- "有什么工具"这一项不能直接读 `member.tools`（白名单快照），否则会误导：
  - 白名单里可能留着**已下线**的工具（如 `ws_read`/`ws_write`，2026-09-12 取消私有区后不再注册）；
  - `ask_user`/`task_assign`/`task_claim`/`task_update`/`artifact_submit` 是**平台交互工具**，
    user 会话始终可用（老项目快照里没有也能用）；
  - 会议专用工具（`meeting_advance`/`meeting_close`/`meeting_ask_user`）在 user 会话不暴露。
    运行期的真实口径在 `src/application/composition.ts` 的 `listTools` 里（内联的过滤 + `PLATFORM_USER_TOOLS`）。

## 2. 设计

### 2.1 工具可用性「单点真相」（新增 `application/tools/tool-selection.ts`）

把 composition 里内联的工具过滤抽成纯函数，运行期与详情查询共用，避免两处规则漂移：

```ts
export const PLATFORM_USER_TOOLS = new Set([...])          // 从 composition 迁入
export function selectToolDefs(member, sessionType)        // 运行期 listTools 用它
export function describeToolAvailability(member, 'user')   // 详情用它
// → { effective: [{ name, source: 'whitelist'|'platform', availableIn }],
//     unavailable: [{ name, availableIn? }] }   // 无 availableIn = 注册表里已没有（下线/未实现）
```

`composition.ts` 的 `listTools` 改为 `selectToolDefs(...).map(...)`，**行为完全不变**（同集合、同顺序）。

### 2.2 新接口 `GET /api/projects/:pid/agents/:iid`（角色详情）

放在 `registerTeamRoutes`（已有 team/agents 路由，持有全部所需服务）。
把 `/agents` 列表里的"团队行投影"（状态推导 + 当前任务）抽成本文件内的一个函数，**列表与详情共用**：

```ts
const rows = await teamRows(pid) // [{ member, row }]，row = 实例 id/显示名/模板 id/enabled/state/sessionId/since/currentTask
return { agent: { ...row, createdAt, model, loop, prompt, promptSource, tools, template } }
```

- `state` 仍走 `deriveAgentState`（单点真相，与 WS `agent.state` 一致）；
- `prompt` = **实例提示词**（运行时读的就是 `member.prompt ?? ''`），`promptSource: 'instance'|'none'`；
  为 `none` 时前端提示"该实例未设置提示词，运行时按空提示词执行"（不做模板兜底，避免与运行期不一致）；
- `template` = `{ roleId, name, category, source }`（模板被删时为 `null`，不抛错）；
- 实例不存在 → `ERR_NOT_FOUND`（404）。

### 2.3 前端：左栏「详情」按钮 + 只读弹窗

- `web/index.html`：新增 `#agent-modal`（复用 `.modal` / `.modal-box` / `.board-head` 既有样式）。
- `web/app.js`：
  - 团队行加「详情」ghost 按钮（`ev.stopPropagation()`，不触发进入会话），`openAgentDetail(instanceId)`；
  - `renderAgentDetail(a)` 分区渲染：身份与配置（实例/模板/来源/创建时间）、模型与 loop（策略 + 中文说明）、
    工具（可用 chips，标注来源；不可用清单标注原因）、提示词（`<pre>` 只读全文）；
  - `bindGlobal` 里绑定关闭按钮。
- `web/style.css`：新增 `.modal-box.agent-detail-box`、`dl.kv`、`.tool-chip`、`pre.agent-prompt` 等少量样式。

## 3. 改动范围

| 文件                                      | 改动                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/application/tools/tool-selection.ts` | 新增：平台工具集 + `selectToolDefs` + `describeToolAvailability`                                      |
| `src/application/composition.ts`          | `listTools` 改用 `selectToolDefs`；删除内联 `PLATFORM_USER_TOOLS` 与 `listToolDefs` 引用              |
| `src/server/app.ts`                       | 抽出 `teamRows`（列表/详情共用）；新增 `GET /api/projects/:pid/agents/:iid`                           |
| `web/index.html`                          | 角色详情弹窗骨架                                                                                      |
| `web/app.js`                              | 团队行「详情」按钮 + `openAgentDetail` / `renderAgentDetail` + 关闭绑定 + loop 中文说明表             |
| `web/style.css`                           | 角色详情弹窗样式                                                                                      |
| `tests/agent-detail-m9e.test.ts`          | 新增：详情字段、工具口径与运行期一致、下线工具进"不可用"、404、停用态                                 |
| `tests/static-web-m8k.test.ts`            | 加一例：详情入口接线（弹窗/按钮/函数/样式类）没断                                                     |
| 文档                                      | 本方案 + `docs/changes/2026-09-13-agent-detail.md` + `api/contract.md` + `frontend/style.md` + README |

## 4. 验证

- `npm run typecheck` / `npm run lint` / `npm run test`（全量）/ `npm run build` 全绿。
- 新用例断言：
  1. 详情返回实例配置：`prompt`（模板快照）/`loop.strategy`/`model`/`template.roleId`；
  2. 工具口径与运行期一致：`dev` 有 `workdir_edit`（source=whitelist），`pm` 无；`ask_user`/`task_assign` 以 platform 出现；
  3. 白名单塞入已下线 `ws_read` → 出现在 `unavailable` 且**无 `availableIn`**（=注册表里没有）；
     同时暴露 dev 白名单里 `fs_search`/`artifact_rollback`/`meeting_advance`/`meeting_ask_user` 均未注册的事实；
  4. 不存在的实例 → 404；停用角色 → `state='disabled'`；`GET /agents` 列表仍正常。
- 手工：真实服务下点左栏「详情」→ 弹窗内容与 `data/projects/<pid>/project.json` 的 `team[]` 一致。

## 5. 边界（本轮不做）

- 只读：不在弹窗里编辑提示词/loop/工具（编辑入口仍走后续版本；后端 `PATCH /team/:iid` 已具备能力）。
- 不展示"注入后的完整系统提示词"（含任务/产出物归属/名册等运行期注入块）——那依赖回合上下文，
  属于调试视图范畴，本轮明确不做。**（同日已由
  [2026-09-13-system-prompt-preview.md](2026-09-13-system-prompt-preview.md) 实现：
  弹窗内可懒加载完整系统提示词并逐段标注来源。）**
- 不展示会话消息/工具调用事件轨迹（澄清时用户选择了"配置一览"）。
- 不做模板库（`/settings/roles`）页面改造；`template` 只带名称与来源。
