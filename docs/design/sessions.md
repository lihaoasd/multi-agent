# 会话模型设计 · Agent Haness

> 类别：design · 状态：草稿(待评审) · 决策依据：D11、prd FR-03/05
> 关联：[memory.md](memory.md)、[data-storage.md](data-storage.md)、[agent-runtime.md](agent-runtime.md)

## 1. 会话（Session）是什么

会话是**交流与协作的容器**，也是记忆的边界单位。MVP 平台只定义**一类**会话：

| type | 参与者 | 数量约束 | 用途 |
| --- | --- | --- | --- |
| `user` | 用户 + **单个** Agent | 每项目每 Agent **1 个**（长期、不关闭；实例停用时归档只读） | 用户↔角色的 1:1 聊天与干活（US-2/3） |

> 角色之间不设 1:1 私聊，也不设多方会话（prd §8）：跨角色协作以**任务委派 + 产出物 + 全局记忆**为媒介，避免脱离用户视线的上下文扩散。

## 2. 会话生命周期与状态机（D16-②；落盘枚举见 data-storage §4.1）

```
user 会话: active（长期 open）⇄ suspended（重启恢复期挂起）→ archived（实例停用时只读归档，D14-9；重新启用回 active）
```

- `active`：长期开放。用户随时可发消息，Agent 忙时消息**入队**（单工，D11）。
- `suspended`：重启恢复期挂起；由 dispatcher occupancy **派生**（D18-④），不单独作为真相持久化（meta 仅缓存）。
- `archived`：实例停用时只读归档（D14-9），重新启用回 `active`。
- **waiting_user 已废弃**（D14 评审定稿）：审批/等用户输入只影响 Agent 状态（`waiting`），其 user 会话**保持 active**，用户随时可继续发消息入队。

> **suspended 为派生投影（D18-④）**：user 会话的 suspended 由 dispatcher occupancy 派生，显示/恢复时统一按 occupancy 重算；meta 可留缓存、非真相源。

## 3. 会话与单工调度的关系（D11）

- 一个 Agent 同一时刻至多属于一个**活动**会话（working/waiting 均占用）。
- Agent 重启恢复期，其 user 会话显示 `suspended`（occupancy 派生，D18-④）；用户消息入队。
- 用户永远可以直接**查看/发送**到自己的会话；发送给 busy Agent 的消息进入该 Agent 队列。

## 4. 会话的存储与读取（详见 data-storage.md §4）

- 每会话 = `<sessionId>.meta.json`（元数据/状态）+ `<sessionId>.log.jsonl`（append-only 全量事件）。
- user 会话 id：`u_<instanceId>`（如 `u_pm_1`），稳定不变 → 项目内角色上下文连续。
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
