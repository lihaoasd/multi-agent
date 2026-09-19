# S45 方案：审批卡按会话归属显示（谁的审批显示在谁的窗口）

> 日期：2026-09-16　类型：用户口径（"谁的发出的审批，应该显示在谁的窗口下面"）　真源：`design/ui.md` §4/§5、`prd.md` FR-29 / FR-30
> 关联：`docs/changes/2026-09-16-s45-approval-scope.md`、`docs/plan/development.md`

## 1 需求

用户口径：**谁发出的审批，就应该显示在谁的窗口下面。**

现状（缺陷）：会话窗口的「待审批（n）」卡直接渲染 `GET /approvals?status=pending` 的**项目全量**——于是 `dev_1` 申请的命令审批会出现在 `qa_1`（或任何其它角色）的会话窗口里；申请者还显示成原始 instanceId（`dev_1`）而不是名字。

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | 审批卡只列**当前会话**的审批 | 切到 B 的会话时，A 的审批不出现；切回 A 才出现（计数同步） |
| R2 | 说清"谁申请的" | 卡片里显示**显示名**（如「高级开发」），查不到才退回 instanceId |
| R3 | 询问卡口径一致 | 询问卡自 S32 起即按会话过滤，本轮统一到同一个纯函数，避免再走偏 |
| R4 | 全局视角不丢 | 右栏「审批」列表仍是项目级（就地批准/拒绝）；本轮不动 |
| R5 | 不改后端 | `ApprovalView` 已带 `sessionId`/`actor`，接口与数据不动 |

## 2 现状与根因

| 位置 | 现状 |
| --- | --- |
| `web/src/pages/SessionPanel.tsx` | `refreshApprovals()` 取项目全量 pending；审批卡 `approvals.map(...)` **不按会话过滤**（`sessionQuestions` 在 S32 已过滤，两者口径不一致） |
| 申请者显示 | `触发者 {approval.actor}` → 原始 instanceId（`dev_1`），与左栏/画布的中文显示名不一致 |
| 右栏 | `RightColumn` 的「审批（n）」是项目级并可就地批准 → 这是**有意的全局视角**（S32/D35） |

## 3 关键决定

1. **抽一个纯函数 `pendingForSession(items, sessionId)`**（`web/src/lib/session-pending.ts`）：审批与询问共用；未选中会话（`null`/空串）时返回空数组；保持原顺序。这样"按会话过滤"只有一处实现，避免审批/询问再次走偏。
2. **只改"显示范围"，不改"处理入口"**：会话窗口里就地批准/拒绝（已有），右栏作为项目级列表保留（可就地处理 + 显示 `actor: summary`）。
3. **申请者用显示名**：会话窗口用 `sessions`/`statuses` 里的 `displayName`（与左栏、画布同源），查不到退回 instanceId；右栏保持原样（项目级视角，本轮不动）。
4. **不改后端**：`ApprovalView` 已带 `sessionId`/`actor`。

## 4 实现步骤

- 新增 `web/src/lib/session-pending.ts`（`pendingForSession` 泛型过滤）。
- `web/src/pages/SessionPanel.tsx`：`sessionApprovals`（`pendingForSession(approvals, activeSessionId)`）替换原来的全量渲染（标题计数与列表都改）；`sessionQuestions` 改用同一函数；新增 `nameOf(instanceId)`（sessions → statuses → instanceId），卡片里「申请者 <显示名>」。
- 测试：新增 `tests/unit/web/session-pending.test.ts`（4：只留当前会话并保序 / 别人的会话为空 / 未选中会话为空 / 空列表）。
- 文档回写：`prd` **D48** + FR-29/FR-30 补注、`ui.md` §4/§5、`README.md`/`plan/development.md`/`testing/plan.md`、验收阶段清单加 `s45`。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 单测 | `session-pending.test.ts` 4 条（含"别人的会话不显示"——正是本次缺陷的修复点） |
| 回归 | `npm test` 全绿 + `coverage` 142/142 + `ratchet` 0 + `typecheck`/`eslint` + `npm run build` |
| **用户点验** | ① 让 A 角色触发一个高危命令（或 doc 提交）→ **只有 A 的会话窗口**出现「待审批（1）」，并且卡片上写的是 A 的中文名 ② 切到 B 的会话窗口不出现 ③ 右栏「审批」仍能看到全局并可处理 |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| 用户看不到"别处还有审批在等我" | 右栏「审批」列表仍是项目级（S32 口径），且拓扑页运行细条/节点状态可见各 Agent 的 `waiting`；会话卡只负责"就地处理当前这个" |
| 审批的 `sessionId` 与实际窗口不符 | `sessionId` 由平台在申请时落盘（`approval.sessionId`），与 `u_<instanceId>` 一致；纯函数按它过滤 |
| 未选中会话时"什么都没显示" | 未选中会话时本就没有可处理的上下文；右栏与左栏列表仍可见 |

## 7 遗留（不在本轮）

- **右栏申请者仍是 instanceId**：右栏没有团队/状态列表，为避免多一次请求保持原样；若要统一成中文名，可把 `sessionApi.status(projectId)` 的结果传进去。
- **审批卡不做"跨会话跳转"**：会话窗口只显示自己的；右栏可就地处理，无需跳转。
