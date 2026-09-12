# 接口约定草案 · Agent Haness

> 类别：api · 状态：草稿(待评审) · 决策依据：架构 §10、FR-12；**本文件为草案**，编码阶段以实际实现为准并回写。
> 关联：[frontend/style.md](../frontend/style.md)、[data-storage.md](../design/data-storage.md)

## 1. 约定

- Base：`/api`；JSON 请求/响应；统一错误体 `{ "code": "ERR_XXX", "message": "…" }`（HTTP 状态码仅作粗分类）。
- id：全部由服务端生成；时间 UTC ISO-8601。
- 实时：WS `ws://host/ws?projectId=…`，上行 `{type,payload}` / 下行 `{type,payload}`，消息为 JSON 文本帧。
- 安全：本机单用户，无鉴权（绑定 127.0.0.1 默认）。

## 2. REST 端点（草案）

### 项目
| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /api/projects | 项目列表 |
| POST | /api/projects | 创建（name/description/workdir/team 配置）|
| GET/PATCH | /api/projects/:pid | 详情 / 改元数据（含重设 workdir）|
| DELETE | /api/projects/:pid | 删除平台数据（二次确认参数 force）|
| GET | /api/fs/browse?path=&depth= | 目录浏览器：**用户级 API，绕过 Agent 沙箱**（本机全盘路径，供创建向导选工作目录；默认过滤/标记系统与隐藏目录、限深度，M8 定稿） |

### 角色库 / 团队
| GET | /api/roles | 模板列表（内置+自定义，含 artifactTypes/tools 元信息）|
| POST/PATCH/DELETE | /api/roles/:roleId | 自建/编辑/删除模板；**内置模板只读、不可原地改/删**——需变更时 UI「基于内置复制新建」（B12/D16-⑤）|
| GET | /api/projects/:pid/team | 实例列表+状态 |
| POST | /api/projects/:pid/team | 增实例（选模板+覆盖配置）|
| PATCH | /api/projects/:pid/team/:iid | 改实例（改名/提示词/模型/loop/工具集/**enabled 停用启用**）|
| DELETE | /api/projects/:pid/team/:iid | **停用实例**（保留会话/工作区/记忆，可重新启用，D14-9）；彻底删除数据为后续版本 |

### 会话 / 消息
| GET | /api/projects/:pid/sessions | 会话列表（user+meeting，含 meta/未读）|
| GET | /api/projects/:pid/sessions/:sid | meta + 窗口消息（`?beforeSeq=&limit=`）|
| POST | /api/projects/:pid/sessions/:sid/messages | 发送用户消息（body:{text}）→ 入队/直接处理 |
| POST | /api/projects/:pid/sessions/:sid/messages/:msgId/continue | 补全/重说未完成回合（D14-⑦）：进程仍在时半截文本可内存续补；进程已重启则临时文本丢失，服务端以已落盘上下文让模型续写；锚点实际用 turnId（B5）|
| GET | /api/projects/:pid/sessions/:sid/log?fromSeq=&kind= | 增量拉日志（重连恢复）；`kind=` 支持**原始事件时间线视图**过滤（D14-④，kind 全集见 data-storage §4.2）|
| POST | /api/projects/:pid/sessions/:sid/hangup | user 会话：暂停 Agent（P1）|

### 会议
| POST | /api/projects/:pid/meetings | 发起（host/主题/议程/成员）→ 生成邀请；返回 state=`proposed`（无占槽会议）或 `queued`（排队，槽空自动转 proposed，D16-①）|
| POST | /api/projects/:pid/meetings/:mid/respond | 成员接受/稍后/拒绝 |
| POST | /api/projects/:pid/meetings/:mid/decision | 用户答复决策点（questionId/choice/text）|
| POST | /api/projects/:pid/meetings/:mid/cancel | 取消 queued/proposed 会议（发起者或用户，D17-②；open/closed 用 close）|
| POST | /api/projects/:pid/meetings/:mid/close | 结束（主持人或用户）→ 触发纪要 |
| GET | /api/projects/:pid/meetings/:mid/minutes | 会议纪要（结构化）|

### 产出物 / 任务 / 审批 / 搜索
| GET | /api/projects/:pid/artifacts | manifest 列表 |
| GET | /api/projects/:pid/artifacts/:aid | 详情（文件清单/diff 摘要）|
| POST | /api/projects/:pid/artifacts/:aid/rollback | 回退到指定版本 |
| GET/POST | /api/projects/:pid/tasks | 任务列表（可按 state/assignee 筛）/ 发布任务（`todo`=已发布待领取，落库后通知受派人）；**同受派人+同题活跃任务自动去重**：新建 201，命中重复 200 `{task, duplicate:true}`，`force:true` 强制新建 |
| PATCH | /api/projects/:pid/tasks/:tid | 改状态（状态含 `terminated`=用户终止，先结算未结算改动，D17-①；已有 in_progress 时置新 in_progress 返回 ERR_CONFLICT）；done/blocked/terminated 会通知委派人 |
| GET | /api/projects/:pid/approvals?status=pending | 审批列表 |
| POST | /api/projects/:pid/approvals/:apid/decide | 批准/拒绝 {decision, reason?} |
| GET | /api/projects/:pid/search?q=&scope=&type= | 关键词检索（会话/记忆分组）|
| GET | /api/projects/:pid/memories?scope=global\|agent&instanceId=&type=&limit= | 记忆列表（只读浏览，M13；P1 支持钉住/编辑/删除 FR-19）|

### 系统
| GET | /api/config | 模型/Provider/策略（只读展示）|
| GET/PUT | /api/settings/models | 模型路由配置（config.yaml 落盘）|
| GET | /api/projects/:pid/export | 导出运行时项目文件夹为 zip（会话/记忆备份）|

## 3. WS 协议

上行（客户端→服务）：
```
{ type:"ping" }
{ type:"subscribe", payload:{projectId, sessionIds?:[]} }
{ type:"send", payload:{projectId, sessionId, text} }        // 发送消息
{ type:"decision", payload:{projectId, meetingId, questionId, choice?, text?} }
{ type:"approval", payload:{approvalId, decision, reason?} }
{ type:"ack", payload:{seq} }                                 // UI 已渲染到 seq，服务端据此算未读
```

下行（服务→客户端）事件（payload 结构随实现细化）：
```
{ type:"session.updated" }            // meta 变化（状态/议程/未读基线）
{ type:"message.chunk", payload:{sessionId, turnId, seq, delta} }   // 流式增量
{ type:"message.commit", payload:{sessionId, seq} }                 // 该消息落盘完成
{ type:"agent.state", payload:{instanceId, state, sessionId} }
{ type:"team.updated", payload:{instanceId, enabled, …} }            // 实例停用/启用（D14-9）
{ type:"task.updated", payload:{taskId, action, state, assignee, creator, title} }  // 任务栏：发布/领取/状态变化（2026-09-12）
{ type:"event.appended", payload:{sessionId, seq, kind}}            // tool/artifact/approval 等事件
{ type:"approval.requested", payload:{approval:…}}
{ type:"meeting.event", payload:{meetingId, kind, …}}              // 轮次/决策点/结束
{ type:"artifact.updated", payload:{artifactId, state}}
{ type:"question.asked", payload:{questionId, asker, kind, question, options, record}}  // 角色提问落盘后即时下行（2026-09-12）
{ type:"question.answered", payload:{questionId, asker, answer}}                       // 回答/多标签页同步撤卡
{ type:"error", payload:{code, message}}
```

顺序保证：同会话事件按 seq 单调下发；`message.commit` 表示该条已落盘（先盘后推，见 memory.md §2）。

> 事件规范（D18-⑤d）：本节 WS 下行事件是规范事件（data-storage.md §4.2 单一事件规范）的 **UI 投影**，与 log kind 一一对应，实现期不得另起旁路事件词汇。

## 4. 错误码（草案）

API 统一返回 `{ code: ERR_*, message }`。工具执行/审计事件内部用简码（`FS_BOUNDARY`/`APPROVAL_REJECTED` 等，见 sandbox.md §8），二者映射如下（M9 定稿：一套语义、两套编码，事件/审计中保留简码，REST 统一 ERR_*）：

| API code | 含义 | 内部简码 |
| --- | --- | --- |
| ERR_NOT_FOUND | 资源不存在 | — |
| ERR_CONFLICT | 状态冲突（Agent busy / 会议已结束 / 文件编辑锁命中 / 版本已回退） | FILE_LOCKED 等 |
| ERR_FORBIDDEN_PATH | 路径越界 | FS_BOUNDARY |
| ERR_APPROVAL_REQUIRED | 动作需审批（返回 approvalId） | APPROVAL_REQUIRED |
| ERR_APPROVAL_REJECTED | 审批被拒（回注 Agent） | APPROVAL_REJECTED |
| ERR_CMD_TIMEOUT | 命令超时被杀 | CMD_TIMEOUT |
| ERR_CMD_FORBIDDEN | 命令被禁（长驻/daemon/交互） | CMD_FORBIDDEN_DAEMON |
| ERR_NET_OFFLINE | 离线模式禁止联网动作 | NET_OFFLINE |
| ERR_VALIDATION | 参数/边界校验失败 | — |
| ERR_MODEL | 模型调用失败（含 provider 未配置） | — |
| ERR_MEETING_BLOCKED | 会议正阻塞等待用户决策 | — |
| ERR_MEETING_FULL | 已有进行中会议，发起排队（D14-⑥） | — |
| ERR_TOOL_REJECTED | 工具被策略拒绝 | — |
| ERR_INTERNAL | 内部错误（审计信息入日志） | — |
