# 会话模型设计 · Agent Haness

> 类别：design · 状态：草稿(待评审) · 决策依据：D2/D11、prd FR-03/05/09
> 关联：[meetings.md](meetings.md)、[memory.md](memory.md)、[data-storage.md](data-storage.md)、[agent-runtime.md](agent-runtime.md)

## 1. 会话（Session）是什么

会话是**交流与协作的容器**，也是记忆的边界单位。平台只定义两类会话：

| type | 参与者 | 数量约束 | 用途 |
| --- | --- | --- | --- |
| `user` | 用户 + **单个** Agent | 每项目每 Agent **1 个**（长期、不关闭；实例停用时归档只读） | 用户↔角色的 1:1 聊天与干活（US-2/3） |
| `meeting` | 用户(恒在) + 主持人 Agent + ≥1 成员 Agent | **MVP：同一项目同一时刻至多 1 个进行中会议**（D14-⑥，其余发起/邀请排队）；与 user 会话互斥占用 Agent | 多方沟通/评审/例会（US-5/6） |

> 角色间不设 1:1 私聊（prd §8）：会外协作以会议、任务委派、产出物与全局记忆为媒介，避免脱离用户视线的上下文扩散。

## 2. 会话生命周期与状态机（按类型分列，D16-①/②；落盘枚举见 data-storage §4.1）

```
user 会话: active（长期 open）⇄ suspended（Agent 被会议占用/重启恢复期挂起）→ archived（实例停用时只读归档，D14-9；重新启用回 active）
meeting:   queued（排队等槽：已有占槽会议时新发起先排队）→ proposed（邀请征询，占槽）→ open（异步进行）
               ⇄ blocked_waiting_user（决策阻塞，全体暂停，等用户拍板）→ closed（自动总结；user 会话不关闭）
```

- `queued`（D16-①）：发起时已有占槽会议（proposed/open/blocked_waiting_user）则落 `queued` 排队、不占槽不占 Agent；槽空后自动转 `proposed`。发起即建会话文件并全量落盘 → 排队/征询中会议**重启可恢复**；queued/proposed 均可由发起者或用户取消（D17-②），UI 显示排队顺序与数量。
- `proposed`（D16-①）：邀请征询期，占唯一会议槽；主持人暂回 user 会话工作（不占），≥1 名成员接受后转 `open` 并正式拉入主持人；全部拒绝由主持人决定取消。
- `blocked_waiting_user`：meeting 专属决策闸门，卡住全体推进，等用户拍板。
- `archived`：仅 user 会话（实例停用时只读归档），重新启用回 active。
- **waiting_user 已废弃**（D14 评审定稿）：审批/等用户输入只影响 Agent 状态（`waiting`），其 user 会话**保持 active**（Agent 未被会议占用时），用户随时可继续发消息入队；会话级"阻塞"仅保留会议的 `blocked_waiting_user` 决策闸门。
- `user` 会话：用户随时可发消息，Agent 忙时排队（单工）；Agent 入会/重启恢复期会话置 `suspended`，消息仍可发（入队）；实例停用后该会话只读（不可再发送）。
- `meeting` 会话：议程到用户决策点时阻塞全体成员（见 meetings.md）。

## 3. 会话与单工调度的关系

- 一个 Agent 同一时刻至多属于一个**活动**会话（working/meeting/waiting）。
- Agent 被拉入会议 → 其 user 会话挂起（会话 meta.state=suspended；界面左栏显示 Agent"会议中"，用户消息排队）。
- 会议结束 → Agent 回到 user 会话继续排队/待命。
- 用户永远可以直接**查看/发送**到任何自己参与的会话；发送给 busy Agent 的消息进入该 Agent 队列。

## 4. 会话的存储与读取（详见 data-storage.md §4）

- 每会话 = `<sessionId>.meta.json`（元数据/状态）+ `<sessionId>.log.jsonl`（append-only 全量事件）。
- user 会话 id：`u_<instanceId>`（如 `u_pm_1`），稳定不变 → 项目内角色上下文连续。
- meeting 会话 id：`m_<hostInstanceId>_<n>`（n 为该主持人发起序号）。
- 读取顺序：meta → 摘要段(跳过) → 最近全量窗口（见 memory.md 上下文窗口策略）。

## 5. 用户与多会话并行

- 用户可同时打开多个项目/会话（UI 多标签），服务端按会话隔离。
- 同一时刻建议用户只在一个会话窗口输入；平台不限制，但消息按会话入队互不影响。

## 6. 会话相关的领域事件（驱动 UI 与记忆）

| 事件 | 触发 | 消费方 |
| --- | --- | --- |
| session.state_changed | 会话/Agent 状态变化 | UI 左栏/右栏状态 |
| session.message_appended | 新消息落盘 | UI 会话流、索引 |
| session.summary_updated | 滚动摘要生成 | 记忆层 |
| meeting.* | 见 meetings.md | UI 会议面板、记忆 |
