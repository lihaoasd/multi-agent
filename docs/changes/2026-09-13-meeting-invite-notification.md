# 2026-09-13 会议入会通知（角色怎么知道要开会）+ 排队会议可接受邀请

- 需求/问题：用户问「如何通知角色，有会议参加」。排查发现**被邀请的角色完全收不到任何通知**：
  `meeting_start` / `create` 只在会议会话里留事件，角色要等到主持人开场、自己在会议会话被点名时
  才知道"我在开会"；它自己的 user 会话里一片空白。
- 类型：feature + bug-fix（顺带修好"排队会议的成员根本无法接受邀请"）
- 改动范围：`application/meeting`、`application/composition.ts`、`tests`、根级测试配置

## 排查结论：角色此前能知道要开会的路只有 2.5 条

| 途径 | 是否通知到角色 |
| --- | --- |
| 会议会话里的 `meeting_event(create/respond/open)` | ❌ 不是它的会话，且它当时没有回合 |
| `occupancy=meeting` → 徽标「会议中」 | ⚠️ 只是状态，不是消息；角色看不到 UI |
| 讨论链在**会议会话**里跑它的发言回合（`【会议邀请】`提示） | ✅ 唯一真正到得了的，但只在开场之后 |

即：`meeting_start` 同步返回后，受邀成员在**自己会话里没有任何"你被拉进会议了"的痕迹**。

## 改动

1. **入会通知**（`MeetingService.onInvited` 钩子 + 组合根实现）：成员 `accept` 时，在**它自己的
   `u_<iid>` 会话**写一条系统消息：
   - `【会议邀请】<主持人> 拉你参加「主题」：描述。` + 「会议已开始」或「本场排队等待中，轮到时自动开始」
   - 末尾明确「你**本轮不用动手**：等主持人开场后点名发言即可（发言写进会议会话）」。
   - **不唤醒回合**（`wake:false`）——避免它在会议还没开场时按旧上下文开工。
2. **排队轮到再通知一次**（`onPromoted`）：槽位空出、排队会议被提升时，给主持人+成员各写一条
   `【会议开始】…现在开始`，然后才跑讨论链。
3. **修 bug：排队会议的成员此前无法接受邀请**——`respond()` 只允许 `proposed/open`，
   而排队会议是 `queued`，`meeting_start` 里那句 `respond(accept).catch(()=>undefined)` 把异常
   静默吞掉 → 排队会议的 `memberDecisions` 永远是空的，轮到后也"没人接受"。
   现在 `queued` 也允许回应（只记录"我参加"，**不占会议槽、不改 open、不写占用**）。
4. **修 bug：`vitest` 收集到运行时数据里的测试**——本项目原本没有 vitest 配置，默认 include 会把
   `data/projects/<pid>/artifact-versions/**` 里**角色运行时产出的** `*.test.js`（交付物副本）
   当成项目测试跑，`npm run test` 出现与代码无关的红（本次实测 10 个 suite 因此失败）。
   新增根级 `vitest.config.js`：`include: ['tests/**/*.test.{ts,js}']` + 排除 `data/**`、`dist/**`。
   配置用**零依赖的普通对象**导出（不 import `vitest/config`）：受限环境里 Vite 打包配置文件
   需要解析外部依赖（spawn）会 EPERM，普通对象无需解析。
5. 顺带把"通知种类"从布尔 `opened` 改为显式 `'invited' | 'started'`（避免位置参数语义漂移）。

## 行为变化

- 角色被拉进会议时，**在自己的会话里能看到一条系统消息**（用户点进该角色会话即可见）。
- 排队中的会议：成员当时就能接受（记录在案），轮到后收到「会议开始」并被正常开场/点名。
- `GET /meetings` 下发 `displayState`/`waiting`（上一轮已加）；本次不改接口形状。
- 新增根级 `vitest.config.js`：`npm run test` 只跑 `tests/`，不受运行时数据影响。

## 验证

- 新增用例（`tests/meeting-queue-m8z.test.ts` 第 3 例）：被邀请者 user 会话收到 `【会议邀请】`
  且 **`turn_start` 为 0**（不唤醒）；排队会议的通知含「排队等待」；轮到后收到 `【会议开始】`。
- 全量：`npm run test` → **40 files / 229 tests passed**；`npm run typecheck`、`npm run lint`、`npm run build` 通过。
- 测试：`tests/meeting-queue-m8z.test.ts`（4 例）

## 已知边界

- 入会通知是**系统消息**、不唤醒回合：角色不会"主动表态"，它的发言仍由主持人在会议会话里点名触发
  （与既有讨论链一致）。若希望成员收到邀请后**自己先表个态**，需要另开一轮唤醒——会带来"开会前各自执行任务"的
  风险，暂不做。
- 通知只发给**受邀成员**（主持人由 `meeting_start` 回执自己知道）；若也要给主持人一条同款消息，一行即可加。
