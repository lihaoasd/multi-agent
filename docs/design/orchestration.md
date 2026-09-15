# 项目编排设计（拓扑图 / 委派 / 领取） · Agent Haness

> 类别：design · 状态：草稿(待评审) · 决策依据：D19-④⑤⑥、prd FR-28/FR-31/FR-32/FR-33、US-17/19/20/21
> 关联：[agent-templates.md](agent-templates.md)、[agent-runtime.md](agent-runtime.md)（单工/状态机）、[data-storage.md](data-storage.md)（落盘）、[tools.md](tools.md)（task_*）、[ui.md](ui.md)（画布）、[contract.md](../api/contract.md)

## 1. 铁律

1. **编排图是项目级的**：节点 = 该项目的 Agent 实例；边 = **"可以创建/委派任务"的有向关系**。
2. **委派只能沿出边**：Agent 发起的任务创建/委派，目标必须是自己的**直接出边节点**；否则拒绝（`ERR_ORCHESTRATION_EDGE`）。
3. **汇报沿同一条边的反向**：受派者完成任务/受阻后回传结果给派发者，属系统行为，不算越权，也不要求存在反向边。
4. **用户不受边约束**：用户（老板）可向任意 Agent 派单、终止、干预；边只约束 **Agent 发起**的委派。
5. **不设项目级运行状态**：没有"开始运行/项目运行中"的全局开关；**用户在某个 Agent 的会话里对话，就表示让该 Agent 开始工作**。
6. **各 Agent 独立工作**：Agent 之间不共享回合、不互等；协作完全通过"任务 + 产出物 + 记忆"发生。
7. **只有用户能编辑编排图**（Agent 不可改图；改图属平台动作，留审计）。

## 2. 数据模型（`orchestration.json`，运行时项目文件夹）

```jsonc
{
  "schemaVersion": 1,
  "projectId": "p_…",
  "version": 3,                          // 每次保存 +1（乐观并发：提交时带 version）
  "updatedAt": "2026-09-14T…Z",
  "updatedBy": "user",
  "nodes": [
    { "instanceId": "pm_1",  "x": 120, "y": 80,  "collapsed": false },
    { "instanceId": "dev_1", "x": 420, "y": 80,  "collapsed": false }
  ],
  "edges": [
    { "id": "e_1", "from": "pm_1", "to": "dev_1", "createdAt": "…" }
  ]
}
```

- 节点坐标只服务画布呈现，不参与调度语义；`instanceId` 必须存在于 `project.json.team`。
- 边为有向、**无自环、无重复**（`from+to` 唯一）；删除实例时级联删除其所有边（在保存/写实例两侧都要校验）。
- 落盘与对账：业务记录文件（`orchestration.json`）原子写成功即生效，随后追加会话/审计投影（沿用 D18-⑤a 主从顺序）。

## 3. 编辑与保存

| 操作 | 校验 |
| --- | --- |
| 添加节点 | 该实例存在、未在图中、未停用实例（`enabled=false` 允许保留卡片但标注"已停用"） |
| 删除节点 | 级联删边；提示受影响的任务/会话（不阻断） |
| 连线 | `from ≠ to`；同向不重复；两端均为本项目实例 |
| 移动/折叠 | 仅布局，无业务校验 |
| 保存 | 全量提交 `nodes + edges + version`；`version` 不匹配 → `ERR_CONFLICT`（提示刷新后重试） |

- **运行中可编辑**：边只影响**未来的委派**，因此不需要"先暂停再改图"；已存在的任务不受影响。
- 保存成功 → 广播 `orchestration.updated`；画布与所有打开的页面同步刷新。

## 4. 运行模型：对话即启动，任务靠领取

```
用户在 Agent A 的会话里发消息（= 让 A 开始工作）
  → A 在自己的 user 会话内作为一次普通回合执行（单工，见 agent-runtime §2）
  → 回合中 A 可调用 task_assign 沿出边创建/委派任务（state=todo，落任务栏并通知受派者）
  → 受派者 B 收到待领取通知；B 在自己的会话/回合中 task_claim 领取 → in_progress
  → B 独立工作（可继续沿自己的出边向下游委派）
  → B 完成 → task_update(done) 汇报给派发者 A；A 据此安排后续（再派发或收尾）
  → 委派/领取的每一步都可在画布与右栏任务列表观测
```

- **不自动接力**：不存在"项目跑起来自己往下推"的编排器；每一步推进都来自某个 Agent 被唤醒（用户对话、任务激活唤醒、领取后的续做）。
- **激活即唤醒**（沿用 D18-③）：任务置 `in_progress` 时向受派者的 user 会话注入唤醒消息，作为确定性开工触发。
- **单工与槽位**（沿用 D17-①）：每个 Agent 至多 1 个 `in_progress`；已有槽位时新任务只能先 `todo` 排队。
- 派发者与受派者的对应关系**由图决定**，这使任务来源可解释（右栏任务列表显示 `creator → assignee` 与来源边）。

## 5. 运行控制：暂停 / 停止（Agent 级）

| 动作 | 语义 | 边界 |
| --- | --- | --- |
| **暂停** pause | 该 Agent 不再领新任务；当前回合执行到**可中断点**后挂起（不再自动续做） | 不影响其它 Agent；已派出的任务仍可被他人领取；恢复 resume 后继续处理队列 |
| **停止** stop | 终止该 Agent **当前任务**（`terminated`）；存在未结算改动时**先结算为一条 code artifact 快照**再终止（可回退，D17-①） | 带确认；不影响其它任务与其它 Agent；不删除产出物与记忆 |

- 入口：会话页会话头、画布节点菜单（见 ui.md §4）。
- 状态投影：暂停显示为 `paused` 徽标（Agent 状态机仍是三态，`paused` 是调度开关而非状态机状态，等价于"临时不领活"，与 `enabled=false` 的区别是**临时且可秒恢复**）。
- 不使用"项目级暂停/停止"：需要整体停机时用实例停用（`enabled=false`）或直接停止各 Agent 当前任务。

## 6. 观测（MVP）

- **节点徽标**：`idle` / `working` / `waiting`（沿用 agent-runtime §2）+ `paused` 叠加标记；显示当前任务标题与最近事件时间。
- **边**：显示最近一次委派时间；`waiting`（提问/审批）时对应节点的徽标高亮（不阻塞整图）。
- **右栏三列表**：任务（状态/受派者/来源/更新时间）、询问（待答）、审批（pending）——三者都是"当前需要用户或 Agent 动作"的入口。
- MVP 不做：活动边流转动画、甘特/进度条、自动布局算法、子图/分组、编排模板（均 P1）。

## 7. 接口与事件

| 类型 | 内容 |
| --- | --- |
| REST | `GET /api/projects/:pid/orchestration`、`PUT /api/projects/:pid/orchestration`（全量保存，带 `version`） |
| REST | `POST /api/projects/:pid/agents/:iid/pause`、`.../resume`、`.../stop` |
| 工具 | `task_assign`（受出边约束）、`task_claim`、`task_update` |
| WS | 下行 `orchestration.updated`、`agent.state`（含 `paused` 标记）、`task.updated` |
| 错误码 | `ERR_ORCHESTRATION_EDGE`（越权委派）、`ERR_ORCHESTRATION_INVALID`（自环/重复边/跨项目节点）、`ERR_CONFLICT`（保存版本冲突、任务槽位占用） |

## 8. 与其它文档的边界

- Agent 状态机、单工、队列与恢复：agent-runtime.md。
- 任务记录与状态机、去重、通知：data-storage.md §7、tools.md §3。
- 询问与审批的落盘与恢复：data-storage.md §7、agent-runtime.md §7。
- 画布交互与右栏呈现：ui.md。

## 9. 未决

- **U12**：是否允许下游**主动**向上游发起沟通（当前只允许"汇报沿反向"，不放开反向主动派单/沟通）。放开会把边从"委派权限"扩展为"双向通信权限"，需重新评估上下文与越权风险。

## 10. 实现口径（2026-09-15，S7）

- **落盘**：`projects/<pid>/orchestration.json`（原子写 + `orchestration:<pid>` 单项目锁）；文件缺失或损坏 → 视为 `version=0` 空图（图属可重建配置）。
- **读取即归一化、不落盘**：`GET` 按当前 `team` 补齐缺失节点（网格默认位 80/60，步长 260/160，每行 3 个）、级联删除已移除实例的节点与边、去重并丢弃自环边；`PUT` 保存前再校验一次同样的规则。
- **校验与错误码**：自环 / 重复边（`from+to`）/ 跨项目或未知实例 / 边端不在图中 → `ERR_ORCHESTRATION_INVALID`（`detail` 带 `from`/`to`/`instanceId`）；`expectedVersion` 不匹配 → `ERR_CONFLICT` + `detail.currentVersion`；保存成功 `version+1` 并发 `orchestration.updated`。
- **委派约束落地**：`TaskService.create` 在 `creator !== 'user'` 时查 `canDelegate(creator, assignee)`，缺失直接返回 `ERR_ORCHESTRATION_EDGE` 且**不创建任务**（用户不受限）。汇报仍沿反向，不要求反向边。
- **画布实现**：设计候选 React Flow **未引入**（避免新增重型依赖）；前端为零依赖 SVG 画布：拖拽移动、连线模式点两端建边、点选/标签删除边、全量保存（带 `version`）、冲突提示刷新重试、节点可就地暂停/继续与跳转会话。活动边动画/自动布局/子图/编排模板仍是 P1。
- **未做**：`POST .../agents/:iid/stop`（S8）、多计划/多图与 U12。
