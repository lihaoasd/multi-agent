# 2026-09-12 会议并发与两态呈现（同一时刻只允许一个进行 + 排队等待）

- 需求/问题：用户要求——①「只能有一个会议进行」；②「会议只有进行中和结束」；
  ③「角色想发起会议、此时有会议进行 → 需要等待」。
- 类型：feature + bug-fix（补上排队会议"永远不会真正开始"的断链）
- 改动范围：`application/meeting`、`application/record`、`application/tools`、`application/composition.ts`、
  `server/app.ts`、`web/`、`docs`、`tests`
- 关键文件：
  - `src/application/meeting/meeting-service.ts`：新增 `meetingDisplayState()`/`withDisplay()`/`listForUi()`/
    `hasActiveMeeting()`；新增 `onPromoted` 钩子（排队会议被提升时触发）
  - `src/application/tools/service-tools.ts`：`meeting_start` 抽出**共用讨论链** `runMeetingChain`；
    排队时**不**开场，并在回执里明确"已排队等待、本轮结束、不要重试"
  - `src/application/composition.ts`：定义 `runMeetingChain`（开场门 → 主持人开场 → 成员发言 → 收尾 → 结束）
    并注入 `onPromoted`；`meetingReadyFor` 供开场门使用
  - `src/application/record/record-service.ts`：会议卡片改为**进行中/已结束都收录**（带 `meetingState`）
  - `src/server/app.ts`：`GET /meetings` 返回 `displayState`/`waiting`；`POST /meetings`、`POST /respond` 同样补呈现态
  - `web/app.js`：左栏与右栏会议徽标改用 `meetingStateZh()`（进行中/已结束 + 排队"· 等待中"）；
    发起会议排队时 toast 说明等待
  - 新增 `tests/meeting-queue-m8z.test.ts`（3 例）；`tests/project-records-m8y.test.ts` 适配新收录规则
  - `README.md` 会议条目补并发与两态口径

## 现状核对（用户三条里哪两条其实已有）

- ①「只能有一个会议进行」：**已有** `activeCount()` 槽位约束（proposed/open/blocked 占槽，queued 不占）。
- ③「有会议进行时发起要等待」：**已有** 落 `queued` 的机制，但**回执与呈现都没告诉发起者"你在等待"**。
- ②「只有进行中和结束」：**没有** —— 内部 5 个状态直接暴露到 UI（征询中/排队中/等你拍板）。

## 根因（写测试时暴露的断链）

`promoteQueuedIfFree()` 只做 `queued → proposed` 与一条事件，**没有任何"开始"动作**：
排队会议永远不会开场、不会发言、也不会结束；`onPromoted` 钩子补上了这一环，
并让"立即开始"与"排队后开始"共用同一条讨论链（避免两套启动逻辑漂移）。

## 行为变化

- 会议对用户**只有两态**：`displayState` = 进行中 / 已结束；排队中的会议额外 `waiting=true`
  （左栏显示「进行中 · 等待中」）。内部状态机不变（仍是 queued/proposed/open/blocked_waiting_user/closed）。
- **同一时刻仍只允许一个会议进行**：第二个及以后发起的一律排队；当前会议结束/取消后自动提升，
  **自动开场**（主持人开场 → 成员发言 → 收尾 → 满足条件自动结束并生成纪要）。
- 角色在有会议进行时 `meeting_start`：回执明确「已**发起并排队等待** … 等当前会议结束后平台会自动开始并通知你，
  你**本轮就到这里**，不要反复重试发起、也不要自己拉人开会」。
- 项目记录页：**进行中的会议也收录**（`meetingState='进行中'`），卡片元信息显示两态；取消的会议仍不收录。
- REST：`GET /meetings` 每项新增 `displayState`、`waiting`；`POST /meetings`、`POST /respond` 返回值同样补上。

## 验证

- 新增 `tests/meeting-queue-m8z.test.ts`（3 例）：
  ① 两态呈现（占槽=进行中 / 排队 waiting=true / 结束=已结束，且提升后 waiting 转 false）；
  ② 有会议进行时角色发起 → 回执含"排队等待""只允许一个会议"，且**同时只有 1 个会议占槽**；
  ③ 排队会议在槽位空出后**自动开始**（主持人的开场发言出现在会议会话里；排队期间没有任何角色发言）。
- 回归：`meeting-m6`、`meeting-round-m6b`、`meeting-shed-m8x`、`minutes-plan-m8e`、`project-records-m8y` 全绿。
- 全量：`npm run test` → **40 files / 228 tests passed**；`npm run typecheck`、`npm run lint`、`npm run build` 通过。
- 测试：新增 `tests/meeting-queue-m8z.test.ts`

## 已知边界

- 「等全员入会再开场」的开场门在排队场景同样生效：提升后若仍有人未就绪，记一条 `meeting_event(action='hold')`
  后照常推进（不把整场会议无限期卡住）。
- 排队顺序 = 发起时间先后（最早优先）；暂不支持插队/优先级。
