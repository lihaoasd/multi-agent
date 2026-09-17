# S21 方案：未完成回合改由 Agent 自查与询问（移除平台固定恢复流程）

> 日期：2026-09-16　类型：需求变更（用户直接指令，二选一确认取最彻底档）　真源：`design/agent-runtime.md` §7、`prd.md` D17-⑤（由 **D27** 修订）
> 关联：`docs/changes/2026-09-16-s21-agent-driven-recovery.md`、`docs/plan/development.md`

## 1 需求

用户原话：**"未完成回合的判断，应该有 agent 判断发起，询问，不能是固定流程"**。

追问确认后的口径（两个问题都选了最彻底那一档）：

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | **平台不再判定未完成回合** | 删除 `RecoveryService`（栈式配对判定）、`GET /api/projects/:pid/recovery`、`GET/POST /api/projects/:pid/sessions/:sid/recovery`、启动自检的未完成回合统计、运行细条里的"未完成回合"字段与标签 |
| R2 | **不再有固定三选流程** | 删除 `RecoveryAction`（`report`/`continue`/`ignore`/`complete`）与四段平台预设提示词 `ACTION_TEXT`；前端 `RecoveryBanner`（汇报中断点/继续执行/补全上次回复/忽略）整块删除 |
| R3 | **Agent 自查能力**：Agent 能看到自己会话的回合边界与最近事件 | 新增只读工具 **`session_recent`**（`session` 包，返回本会话最近 N 条事件：`#seq [turn N] kind ts 摘要`，**含 `turn_start`/`turn_end`**），Agent 据此自行判断"上一回合是否收尾、自己的最后一条回复是否完整" |
| R4 | **Agent 主动询问**：判断后由 Agent 用 `ask_user` 发起询问，问题与选项由它自己组织 | `context-builder` 的「平台角色定位」块增加**职责**（怀疑上回合并未收尾 → 先自查 → 先说明现状 → 用 `ask_user` 问我怎么处理，不要擅自续跑）；询问走既有 `ask_user` 通道（询问列表 + 会话内询问卡，D23 的 `interaction` 包） |
| R5 | 不自动续跑仍然成立（D16-③ 保持） | 平台不注入任何恢复消息、不自动唤醒；Agent 只在下一次真正运行时（用户消息/派单/排队补处理）才会看到这条职责 |
| R6 | 契约与文档同步 | `contract.md` 删三条路由；`agent-runtime.md` §7、`data-storage.md`、`memory.md`、`tools.md`、`tool-packages.md`、`ui.md`、`README` 术语与规则 19 全部按新口径回写 |

## 2 为什么必须新增工具（关键发现）

用户选项描述里写的是"它有 `session_search`"，但**实测不成立**：

- `session_search`（`infra/tools/builtin/memory.ts`）是**关键词检索**，返回"命中的会话 id + seq + 片段"，**看不到 `turn_start`/`turn_end` 这类边界事件**，也没有"最近事件"的时间序视图；
- 因此现有条件下 Agent **无法**判断"上一回合是否收尾"——照现状直接删掉平台检测，就会退化成"没有任何人能发现中断"。

所以本轮必须补一个**只读事实视图**。它只给事实（事件序列 + 回合边界），**不给结论**（不返回"未完成回合=第 N 个"这种平台判定），判断与询问都归 Agent。

## 3 现状与影响面

| 面 | 位置 | 现状 |
| --- | --- | --- |
| 端口 | `src/ports/runtime.ts` | `RecoveryAction`/`UnfinishedTurn`/`RecoveryService`/`RecoveryMarker`/`readRecoveryMarker`；`RuntimeAgentView.unfinishedTurn` |
| application | `src/application/recovery/recovery-service.ts` | 栈式配对判定 + `ACTION_TEXT` 四段预设提示词 + `resolve()` 落标记并唤醒 |
| application | `src/application/runtime/runtime-service.ts` | 细条数据叠加 `unfinishedTurn` |
| server | `src/server/http-routes/runtime.ts` | `/recovery` 三条路由 + `ACTIONS` 白名单 |
| bootstrap | `composition-root.ts`、`main.ts` | RecoveryService 装配；启动自检统计未完成回合并记日志 |
| web | `api/runtime.ts`、`pages/RecoveryBanner.tsx`、`SessionPanel.tsx`、`WorkingBar.tsx` | 横幅三选 + 补全；会话页挂载；细条「未完成回合」标签 |
| 工具 | `infra/tools/builtin/memory.ts` | `session` 包只有 `session_search`（关键词检索） |
| 测试 | `unit/application/runtime-recovery.test.ts`、`integration/server/runtime-api.test.ts` | 规则 19/14 的 16 条用例 |

## 4 关键决定

1. **平台只做两件事：不检测、不指挥**。删除全部检测与固定动作；平台保留的只是"提供事实 + 转述职责"。
2. **新工具的定位是"事件视图"而不是"体检报告"**：`session_recent` 返回最近 N 条事件的 `seq/turn/kind/ts/摘要`（含回合边界），**不返回任何"未完成"结论**——判断归 Agent，这样才不违背"不能是固定流程"。
3. **职责写进「平台角色定位」上下文块**（`context-builder.ts`，每回合注入），内容只描述**职责与顺序**（先自查 → 先说明 → 需要决策就 `ask_user`），**不预设选项**（原来 `ACTION_TEXT` 的"汇报中断点/继续执行/补全"三选正是被删掉的东西）。
4. **`session_recent` 只读自己的会话**：用 `ToolContext.sessionId`（`ports/tools.ts` 已有该字段），不接受 sessionId 参数，因此不存在越权读别人会话的可能。
5. **工具走端口不走 application**：`infra` 层被 ESLint 禁依赖 `application`（`eslint.config.js` 第 124 行），因此工具依赖声明为**端口类型** `SessionLogStore`（`readWindow` 是**尾窗**语义，正是"最近 N 条"），由 composition-root 注入；这也与 `TaskToolDeps`/`ArtifactToolDeps` 用端口的既有约定一致。
6. **承认并记录功能损失**（用户已知悉）：平台不再主动提示，**重启后若该 Agent 一直没被唤醒（用户不再发消息、也没人派单给它），中断就永远不会被发现**。这是本决策的直接代价（D27-⑥ 明写）。
7. **不回滚排队消息恢复**（D18-③）与停止生成/停止任务（S8 的其它部分）——它们与"未完成回合判定"无关，保持原样。

## 5 实现步骤

**A. 后端移除**
- `src/ports/runtime.ts`：删 `RecoveryAction`/`UnfinishedTurn`/`RecoveryService`/`RecoveryMarker`/`readRecoveryMarker` 与 `RuntimeAgentView.unfinishedTurn`；文件头注释改写为"运行控制端口（细条/停止/导出）"。
- 删除 `src/application/recovery/recovery-service.ts`（含目录）。
- `src/application/runtime/runtime-service.ts`：去掉 `recovery` 依赖与 `unfinishedTurn` 字段。
- `src/server/http-routes/runtime.ts`：删三条 `/recovery` 路由与 `ACTIONS`、`recovery` 上下文。
- `src/server/app.ts`、`src/bootstrap/composition-root.ts`、`src/bootstrap/main.ts`：去掉 `RecoveryService` 装配与启动自检里的未完成回合统计。
- `tests/helpers-server.ts`：去掉 `recovery` 注入。

**B. Agent 自查能力**
- `src/infra/tools/builtin/memory.ts`：新增 `sessionRecentTool`（`name: 'session_recent'`、`package: 'session'`、`risk: 'none'`、`network: 'none'`、`idempotent: true`、`availableIn: ['user']`、`output.maxChars: 6000`），参数 `{limit?: number}`（默认 30、上限 100），用 `SessionLogStore.readWindow(projectId, sessionId, {limit})` 取尾窗，逐条渲染 `#seq [turn N] kind ts 摘要`；`MemoryToolDeps` 增 `sessionLog: SessionLogStore`。
- `src/infra/tools/builtin/index.ts`：`memoryTools({ memory, search, sessionLog })` + deps 类型扩展。
- `src/bootstrap/composition-root.ts`：注入 `sessionLog: container.resolve<SessionLogStore>(TOKENS.SessionLogStore)`。
- `src/application/agent-loop/context-builder.ts`：「平台角色定位」块补一条职责（见 §4-3）。

**C. 前端收口**
- `web/src/api/runtime.ts`：删 recovery 类型与方法、`unfinishedTurn` 字段。
- 删除 `web/src/pages/RecoveryBanner.tsx`；`SessionPanel.tsx` 去掉挂载与 `onResolved`；`WorkingBar.tsx` 去掉「未完成回合」标签。

**D. 测试**
- 删除 `tests/unit/application/runtime-recovery.test.ts`。
- `tests/integration/server/runtime-api.test.ts`：删 recovery 用例（保留 `/runtime`、`stop`、`export`）。
- 新增 `tests/unit/infra/session-recent-tool.test.ts`：尾窗语义、含 `turn_start`/`turn_end`、`limit` 边界（默认/上限/超量）、空会话、只读本会话（无 sessionId 参数）。
- `tests/integration/server/tool-packages-api.test.ts`：`session` 包工具数 1 → 2（双向一致性断言）。
- `tests/acceptance/prd-section9.test.ts`：仅阶段清单加 `s21`（脚本 3 未使用 recovery，无需改）。

**E. 文档**
- prd：新增 **D27**（修订 D17-⑤、D16-③ 的恢复入口口径）；D17-⑤ 行内标注。
- `agent-runtime.md` §7 重写 + §5/§6 相关句（含工具表的 `session_recent`）；`data-storage.md`（恢复标记一节改为"不再有恢复标记"）；`memory.md`（中断恢复一句）；`ui.md` §3（细条去掉未完成回合）、§4（横幅删除 + 职责说明）；`contract.md`（删三条路由）；`tools.md`（工具表 + 已注册清单 + 角色白名单）；`tool-packages.md`（`session` 包工具列）；`README.md`（术语「未完成回合」重写 + 阶段索引 S0~S21）；`plan/development.md` §3/§6；`testing/plan.md` 规则 19 重写 + §5 映射 + §6 记录。

## 6 验证方式

| 层 | 手段 |
| --- | --- |
| 类型/规范 | `npm run typecheck`（src + web）、`npx eslint .`（重点看 infra 未越层依赖 application） |
| 构建 | `npm run build` |
| 测试 | `npm test`（新增工具用例 + 既有 314 条去掉 recovery 用例后的回归）、`npm run coverage`（删除文件后可达数下降属预期）、`npm run ratchet` |
| 契约 | `GET /api/projects/:pid/recovery` 与 `.../sessions/:sid/recovery` 返回 **404**；`GET /runtime` 响应不再含 `unfinishedTurn` |
| 工具 | `GET /api/tool-packages` 的 `session` 包含 `session_recent`；活体让 Agent 调一次 `session_recent` 能看到带 `turn_start/turn_end` 的清单（脚本化网关剧本） |
| **用户点验** | 刷新后：会话页不再有未完成回合横幅；细条不再显示"未完成回合"；重启服务后发一条消息给某 Agent，它应当先自查并**主动提问**（而不是平台弹三选） |

## 7 风险

| 风险 | 对策 |
| --- | --- |
| **中断可能永远不被发现**（平台不再提示） | 用户已确认接受；D27-⑥ 明写；缓解手段是职责注入（每次该 Agent 真正运行都会看到） |
| Agent 忽略职责、直接续跑 | 职责文案明确"先问再动"；用户可在角色模板提示词里强化（提示词可编辑，FR-35） |
| `session_recent` 输出过大挤占上下文 | 默认 30 条、上限 100 条、`output.maxChars: 6000`（`truncate-tail`），且只在本会话内读 |
| 删除 API 属破坏性契约变更 | `contract.md` 同步删除并在 changes 记录里写明；本机单用户、无外部消费者 |
| 旧数据里的 `state` 恢复标记（`{unfinishedTurn, recovery}`）成为孤儿 | 无需迁移：它只是日志事件，删掉读取方后不再被解释；`data-storage.md` 记明"历史标记保留但不再消费" |
