# S16 方案：会话页瘦身（去掉「实时通道已连接」成功态提示）

> 日期：2026-09-16　类型：UI 简化（用户直接指令）　真源：`design/ui.md` §4（对话页）
> 关联：`docs/changes/2026-09-16-s16-session-page-slim.md`、`docs/plan/development.md`

## 1 需求

用户口径：**"会话页，实时通道已连接不需要"**。

确认后的实现口径（用户三选一回答，选 A）：

| # | 需求 | 验收 |
| --- | --- | --- |
| R1 | 会话页在 **WS 连通时不再显示任何连接相关提示** | 进入会话页且通道正常时，页面顶部**没有**「实时通道已连接（事件先落盘后推送）」这条绿色 Alert |
| R2 | **断开/重连中仍显示一条警告**（用户选 A："不然事件不刷新用户无从得知"） | 停止服务端或断网后，会话页出现 warning「实时通道未连接，正在重试…」；恢复后自动消失 |
| R3 | 随该提示条一并移除其 `description` 的开发期说明（"回复由真实 agent loop 生成（S4 起）：工作日志默认折叠，可用右上角过滤按 kind 查看；右栏三列表实时刷新。"） | 页面上不再出现 `S4 起` / `工作日志默认折叠` 这段说明文字（用户选 A 而非 C，故不保留为常驻小字） |
| R4 | **行为不变**：`useRealtime` 的连接/重连退避/订阅逻辑、事件增量拉取、其它提示（会话错误 Alert、`RecoveryBanner`）都不动 | 断开→恢复仍能自动重连并继续增量拉事件；后端与 WS 契约无改动 |

## 2 现状与影响面

| 面 | 位置 | 现状 |
| --- | --- | --- |
| 前端 | `web/src/pages/SessionPanel.tsx` 第 217~222 行 | 常驻一条 Alert：`type` 随 `realtime.connected` 在 `success`/`warning` 间切换，`message` 为「实时通道已连接（事件先落盘后推送）」或「实时通道未连接，正在重试…」，并固定带一段开发期 `description` |
| 前端 | `web/src/hooks/useRealtime.ts` | 连接 `/ws?projectId=…`、失败退避重连（1s→5s 上限）；**重连成功后不会自动补拉断开期间的事件**（只有收到新帧或切换会话时才拉）→ 这正是"断开必须提示"的理由 |
| 后端 | `src/server/ws/*` | **本轮不改** |
| 文档 | `docs/design/ui.md` §4（对话页） | 未描述这条连接提示；`docs/testing/plan.md` 无对应规则（无规则改动） |

## 3 关键决定

1. **只保留"坏消息"**：连接正常是默认预期，不需要常驻报喜；断开才是需要用户知道的状态（事件不刷新、界面可能滞后）。这与 S15"空闲不渲染"是同一种口径——**没有信息量的常驻提示一律不占版面**。
2. **不新增文案**：断线文案沿用原文「实时通道未连接，正在重试…」，不写"重连后自动补齐"之类**当前不成立**的承诺——`useRealtime` 重连后没有事件补偿，实际补齐要靠切换会话/刷新（已记入改动记录的遗留项，不在本轮改逻辑）。
3. **`description` 一并删除**（用户选 A 而非 C）：那段是开发期 onboarding 文案（含 `S4 起` 阶段标记），不是运行期信息；"工作日志默认折叠/可按 kind 过滤"在折叠卡标题上已经自解释。
4. **不动连接逻辑、不动后端**：本轮只删展示分支，`useRealtime` 与 WS 契约零改动，因此不新增后端测试，只跑回归。

## 4 实现步骤

- `web/src/pages/SessionPanel.tsx`：把常驻 Alert 改为**仅在未连接时渲染**：
  ```tsx
  {!realtime.connected && <Alert type="warning" showIcon message="实时通道未连接，正在重试…" />}
  ```
  删除 `description` 与 `type/message` 的三元分支（`realtime.connected` 仍被使用，`useRealtime` 引入不变）。
- 文档回写：`design/ui.md` §4 增一条"连接状态提示"口径；`docs/README.md` §1/§3.4、`plan/development.md` §3/§6、`testing/plan.md` §6 增 S16；`tests/acceptance/prd-section9.test.ts` 阶段清单加 `s16`。
- prd 不新增决策行（无用户故事/功能需求/验收口径变化，与 S12 同类处理）。

## 5 验证方式

| 层 | 手段 |
| --- | --- |
| 类型/规范 | `npm run typecheck`（src + web）、`npx eslint .` |
| 构建 | `npm run build`（vite 产物更新） |
| 产物冒烟 | 产物中 `实时通道已连接` **不出现**、`S4 起` **不出现**、`实时通道未连接` **出现** |
| 活体 | 服务端静态服务 `web/dist`：`GET /assets/<新产物>.js` 与产物冒烟结论一致 |
| 回归 | `npm test` 全绿 + `npm run coverage` 触达门禁 + `npm run ratchet` |
| 说明 | 本仓库无前端测试设施（Vitest 仅覆盖 node 侧），UI 以 **构建 + 产物冒烟 + 代码审阅** 为准，与 S4/S7/S12/S15 的 UI 交付口径一致；断开/恢复的点击级验证需用户在浏览器刷新后确认 |

## 6 风险

| 风险 | 对策 |
| --- | --- |
| 用户其实想连"未连接"警告也去掉 | 只影响一个条件渲染：再删 `!realtime.connected &&` 这一层即可（不改任何逻辑） |
| 断线期间漏事件被误认为 bug | 属既有行为（`useRealtime` 无重连补偿），本轮在改动记录"遗留"里写明；若要修，应另立需求走 `onopen` 补偿拉取 |
| 误删会话页其它提示 | 只改这一处 Alert；`error` Alert 与 `RecoveryBanner`（未完成回合三选）保持原样，且被加入本轮验收检查项 |
