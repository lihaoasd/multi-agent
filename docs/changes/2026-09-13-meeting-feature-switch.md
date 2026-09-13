# 2026-09-13 会议功能总开关（`meeting.enabled`）

- 需求/问题：用户要求「会议功能关闭」。
- 类型：feature（功能开关）+ 行为变更（关闭时会议相关能力整体不可用）
- 改动范围：`shared/config`、`server/app.ts`、`application/tools`、`application/composition.ts`、`web/`、`config.yaml`、`tests`

## 语义（按"关掉整个会议功能、数据保留、可重新打开"实现）

`config.yaml` → `meeting.enabled: false` 后：

| 层面 | 关闭后的行为 |
| --- | --- |
| 角色工具 | **不注册** `meeting_start` / `meeting_close` / `meeting_talk`——角色连"能开会"都不知道（不是注册了再报错） |
| 会议 REST | `GET /meetings` 返回 `{ meetings: [], disabled: true }`；创建/回应/结束/取消/点名/纪要等**全部 409 `ERR_MEETING_DISABLED`** |
| 平台链路 | 讨论链（`runMeetingChain`）直接返回；step 边界闸门（会议邀请）直接放行 |
| 前端 | `/api/capabilities` 下发 `meeting:false` → 隐藏左栏「会议」区、「＋发起」、右栏「当前会议」；`＋发起` 兜底 toast「会议功能已关闭」 |
| 数据 | **保留**（`m_*.meta.json` 等原样在盘上），改回 `true` 重启即可继续看到历史会议与纪要 |

字段为**可选**（`enabled?: boolean`，缺省视为开启），因此旧配置/测试里的
`config.meeting = { autoStart, autoClose }` 仍然合法，不必逐处补字段。

## 改动

- `shared/config.ts`：`MeetingConfig.enabled?: boolean`（默认 `true`）。
- `server/app.ts`：`registerMeetingRoutes` 在关闭时注册"拒绝版"路由；新增
  `GET /api/capabilities` → `{ capabilities: { meeting } }`。
- `application/tools/service-tools.ts`：新增 `meetingsEnabled`（缺省 true），false 时整段跳过会议工具注册。
- `application/composition.ts`：透传 `meetingsEnabled`；讨论链与 step 闸门在关闭时短路。
- `web/index.html` / `web/app.js`：给会议区加稳定 id，`boot()` 拉一次 `/capabilities` 并按开关隐藏/兜底提示。
- `config.yaml`：补 `meeting.enabled` 注释与默认值。

## 验证

- 新增 `tests/meeting-disabled-m9b.test.ts`（3 例）：
  ① REST 被拒（列表空 + `disabled`，创建/结束 409 `ERR_MEETING_DISABLED`）；
  ② 角色看不到三个会议工具（注册表断言）+ 直接调用被拒；
  ③ 能力开关下发 false → **数据保留** → 重新打开后会议与主题仍在。
- 全量：`npm run test` → **42 files / 235 tests passed**；`npm run typecheck`、`npm run lint`、`npm run build` 通过。
- 测试：新增 `tests/meeting-disabled-m9b.test.ts`

## 已知边界

- 会议关闭时**已在进行的会议**不会被打断：本次只保证"不再产生新会议、入口不可用"。
  若要"关闭即取消/结束进行中的会议"，需要额外一条收尾策略（按项目遍历 open 会议 → close/cancel），暂未做。
- 关闭只影响会议；任务/审批/提问/项目记录（其中会议卡片会自然消失，因为列表为空）不受影响。
