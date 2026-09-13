# 2026-09-13 会议入会流程：step 边界闸门 + 平台记报到 + 全员到齐才开场

- 需求/问题：用户提出会议流程——主持人发起 → 通知所有角色 → **主持人等所有人进入会议** →
  被邀请角色**在每个 step 结束后**发现"我被叫去开会" → **结束当前工作、报到、等主持人发话、参与讨论**。
- 类型：feature（会议入会握手）+ 1 个 loop 能力扩展（step 边界闸门）
- 改动范围：`application/agent-loop`、`application/meeting`、`application/composition.ts`、
  `shared/config`、`config.yaml`、`tests`、`docs`

## 与用户设计的三处偏差（沟通后确认，均为必要性修正）

| 用户原设计 | 实际实现 | 原因 |
| --- | --- | --- |
| 主持人**轮询**等待所有人进入 | 主持人**结束回合**；平台记报到，**全员到齐后跑讨论链开场** | `SessionService` 按实例单工串行（`projectId:instanceId` FIFO）：主持人在自己回合里等"别人报到"，而报到要靠队列推进 → **必然死锁**。等价于已有的"系统消息 + 唤醒"模式 |
| 每个 step **postStep 查询**是否被邀请 | 平台在 `respond(accept)` 时**主动记账**，loop 只在 step 边界做一次**本地台账判断** | "谁接受了邀请"平台本来就知道；让每个角色每步去问服务端是冗余查询，且时序更差 |
| 角色自己"报道：我已经进入" | **平台记报到**（`meeting.memberJoined` + `meeting_event(action='join')`） | 报到不能依赖模型写对一句话，否则主持人永远等不齐 |

用户对两个取舍明确选了：**只在 step 边界停**（不停在半个 step 上）、**平台记报到**。

## 实现

### 1. 邀请/报到台账 `application/meeting/invite-store.ts`（新增，`meeting-invites.jsonl`）

`invited` / `joined` / `left` 三态：`hasPendingInvite()` 供闸门判断，`markJoined()` 记报到，`markLeft()` 散会解除。

### 2. loop 的 step 边界闸门（`loop-runner.ts`）

- `ToolRuntimeHook.shouldYield(ctx)`：每执行完一步工具调用一次，返回非空文本 = **停下本回合**。
- 停下时：**落一条系统消息**说明原因（角色下一轮/会议会话可见）；**不跑收尾回合**（任务是被会议打断，不是完成）；
  也**不催任务状态**（与 `ask_user` 挂起同样处理）。
- 组合根实现：非会议会话 + 台账里"被邀请但未报到" → 返回停手原因。

### 3. 会议服务（`meeting-service.ts`）

- 新增 `memberJoined`（会议记录内，谁已报到）与 `markJoined()`：写记录 + 落 `meeting_event(action='join')`，
  返回 `{ allJoined, joined, waiting }`。
- `respond()`：**`queued` 也允许回应**（只记"我参加"，不占槽/不改 open/不写占用——修好了"排队会议的成员无法接受邀请"）；
  `open` 分支在占用后**记报到**并触发 `onJoined(allJoined)`。
- 移除 `onPromoted` 里的讨论链（开场改由"全员到齐"决定，排队提升只通知）。

### 4. 组合根

- `onInvited`：给被邀请者自己的会话写【会议邀请】/【会议开始】系统消息，**唤醒一次**
  （空闲角色才会被叫起来走到闸门；不唤醒会让主持人永远等不到人）。
- `onJoined`：记台账；**全员到齐 → 跑讨论链**（主持人开场 → 逐个点名 → 收尾 → 结束）。
- 散会回注时 `markLeft` 解除闸门。

### 5. 会议自动开始/收尾可配置（`config.meeting.{autoStart,autoClose}`，默认 `true`）

`autoStart` 关掉后，会议停在 open、不自动开场——测试用于断言中间态，部署时也可手动控制节奏。

## 行为变化

- 角色被会议邀请后：**在自己会话收到系统消息**（会唤醒一次），并在**下一个 step 边界**停手，
  落一条"被拉进会议、停止工作"的系统消息；任务保持进行中、不被催促。
- 主持人**不再轮询**：全员报到后由平台直接开场（主持人开场回合跑在会议会话里）。
- 会议人数不齐（如某成员一直未接受）时**不会开场**——这是新语义（此前 `meeting_start` 会立刻开场）。
- 新增配置项 `meeting.autoStart` / `meeting.autoClose`（缺省均 true，与既有行为一致）。

## 验证

- 全量：`npm run test` → **41 files / 232 tests passed**；`npm run typecheck`、`npm run lint`、`npm run build` 通过。
- 新增 `tests/meeting-yield-m9a.test.ts`（3 例，真实台账 + 真实 loop）：
  ① 干活到一半被邀请 → **只跑 1 步**、落"被拉进会议/停止工作"系统消息、不跑收尾、不催任务状态、任务仍 in_progress；
  ② 无邀请时闸门不生效（正常多步）；
  ③ 会议会话内发言不受闸门约束。
- `tests/meeting-queue-m8z.test.ts` 适配新语义：邀请会唤醒、排队会议可接受、全员报到才开场。
- 4 个手动推进会议的用例文件显式关闭自动开始/收尾（`meeting-m6`、`meeting-round-m6b`、`attention-m8d`、
  `project-records-m8y`、`team-status-m8i` 按用例粒度）。
- 测试：新增 `tests/meeting-yield-m9a.test.ts`

## 已知边界

- 闸门只在 **step 边界**检查：模型若一步就结束（没有工具调用），会在回合末尾才自然停；这是"不停在半个 step"的代价。
- 报到记在"接受邀请"那一刻，不等角色真正停手——因此主持人可能比某成员的实际停手早一点开场（该成员的会议发言回合
  与它自己的回合同实例串行，仍会按序执行，不会并行冲突）。
- 会议人数不齐时会议一直 open 占槽（不自动取消）；需要"超时自动放弃缺席成员"时另行设计。
