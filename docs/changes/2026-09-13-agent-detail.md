# 2026-09-13 角色详情（每个角色可查看提示词 / agent loop / 工具 / 模型 / 状态）

- 需求/问题（用户口述）："每个角色，可以查看他的详细消息，提示词，loop 是哪个，有什么工具等"。
  澄清定案：① "详细消息" = **角色详细信息（配置一览）**，不是会话消息轨迹；
  ② 入口 = **左栏角色行「详情」按钮 → 只读弹窗**。
- 类型：feature（只读查询 + 界面入口），无行为变更（运行期逻辑等价重构）
- 改动范围：`application/tools`、`application/composition.ts`、`server/app.ts`、`web/`、`tests/`

## 语义

左栏团队行新增「详情」（悬停可见，与「停用/启用」并列，点击不进会话），弹窗只读展示：

| 分区        | 内容                                                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 身份与配置  | 显示名（实例 id）、角色模板（内置/自建）、状态徽标、当前任务、所在会话、创建时间                                                        |
| 模型与 loop | `model`（provider id）、`loop.strategy` + 中文说明（direct/reflective/plan-execute，未知策略显示"自定义策略"）、loop params（有则显示） |
| 工具        | **user 会话实际可用**清单（与运行期同口径，标注 `白名单` / `平台` 来源），以及"白名单里配了却用不上"的清单                              |
| 提示词      | 实例提示词全文（`<pre>` 只读）；实例未设提示词时提示"运行时按空提示词执行（不回落模板）"                                                |

后端新接口 `GET /api/projects/:pid/agents/:iid` → `{ agent: {...} }`，实例不存在返回 404 `ERR_NOT_FOUND`。

## 改动

- **新增 `src/application/tools/tool-selection.ts`**（工具可用性**单点真相**）：
  `PLATFORM_USER_TOOLS` + `selectToolDefs(member, sessionType)` + `describeToolAvailability(member, 'user')`。
- `src/application/composition.ts`：`loopOpts.toolRuntime.listTools` 改为调用 `selectToolDefs(...)`，
  删除内联的平台工具集与 `listToolDefs` 引用——**过滤规则与结果集完全不变**，只是搬了个家。
- `src/server/app.ts`：把 `/agents` 列表的"团队行投影"抽成本文件内的 `teamRows(pid)`（列表与详情共用，
  状态仍走 `deriveAgentState` 单点）；新增 `GET /api/projects/:pid/agents/:iid`。
  详情里 `prompt` 直接给 `member.prompt ?? ''`（**与 loop-runner 运行期一致，不做模板兜底**），并给
  `promptSource: 'instance' | 'none'`；`template` 在模板被删时为 `null`（不抛错）。
- `web/index.html` / `web/app.js` / `web/style.css`：详情弹窗骨架、团队行「详情」按钮、
  `openAgentDetail` / `renderAgentDetail`（纯 `textContent` 渲染，无 HTML 注入面）、关闭按钮绑定、
  `AGENT_LOOP_ZH` 策略中文说明、弹窗样式（表头常驻 + 正文滚动）。
- `tests/model-gateway-fallback-m9d.test.ts`：**附带修复**——`fetch` mock 的入参注解用了 DOM 类型
  `RequestInfo`（本项目 tsconfig 无 DOM lib），导致 `npm run typecheck` 在本次改动前就是红的；
  去掉注解改为推断（不改变测试语义）。

## 验证

- `npm run typecheck`、`npm run lint`、`npm run build` 全绿；`npm run test` → **45 files / 251 tests passed**。
- 新增 `tests/agent-detail-m9e.test.ts`（5 例）：
  ① 配置字段（提示词快照/loop/模型/模板来源/创建时间）；
  ② **工具清单与运行期逐名一致**（测试侧按注册表 + 平台工具独立算一遍再比对），来源标注正确
  （`workdir_edit`=whitelist、`ask_user`=platform；`pm` 无 `workdir_edit`/`cmd_run`）；
  ③ 白名单里的过时工具 → 进"用不上"清单（`ws_read` 无 `availableIn`）；
  ④ `prompt:null` → 空提示词 + `promptSource='none'`；
  ⑤ 未知实例 404 + 停用后 `state='disabled'` + `GET /agents` 列表不受影响。
- `tests/static-web-m8k.test.ts` 加 1 例：详情入口接线（`agent-modal`/`agent-detail-body`/`btn-agent-close`/
  `openAgentDetail`/`renderAgentDetail`/`AGENT_LOOP_ZH`/`.agent-detail-box`/`.tool-chip`）没断。
- 真实数据冒烟（本机 `data/projects/p_mtzc403eww1816`，跑 dist 产物 `app.inject`）：`dev_1` 返回
  真实模型 `DeepSeek-V4.1-Flash`、`plan-execute`、提示词快照、14 个可用工具（10 个白名单来源 + 4 个平台来源）
  与 4 个"用不上"工具，字段与 `project.json` 一致。

## 已知边界

- **只读**：弹窗不能改提示词/loop/工具（后端 `PATCH /projects/:pid/team/:iid` 已具备该能力，界面入口后续版本再加）。
- 不展示"注入后的完整系统提示词"（任务/产出物归属/团队名册等运行期注入块依赖回合上下文），
  也不展示该角色的会话消息/工具调用事件轨迹（澄清时用户选择"配置一览"）。
- 详情里的 `template` 只带名称/类别/来源；模板库（`/settings/roles`）页面未改。
- **顺带暴露的既有事实（非本次引入）**：内置模板白名单里的 `fs_search`、`artifact_rollback`、
  `meeting_advance`、`meeting_ask_user` **均未注册**（工具尚未实现），详情页会如实把它们列进
  "未注册，可能已下线或尚未实现"，而不是假装可用。要不要补实现属另一件事。
