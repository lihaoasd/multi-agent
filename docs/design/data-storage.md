# 数据与存储设计 · Agent Haness

> 类别：design · 状态：草稿(待评审) · 决策依据：D5/D6/D7（不用 SQLite、纯文件系统、双层记忆+关键词检索）
> 关联：[architecture.md](architecture.md)、[memory.md](memory.md)、[workspaces-artifacts.md](workspaces-artifacts.md)

## 1. 存储原则

1. **无数据库**：全部为文件系统上的 JSON / JSONL / Markdown / YAML。任何"库"都是目录。
2. **项目即文件夹**：一个项目 = `运行时项目文件夹`（配置/会话日志/记忆/manifest，**可拷贝迁移**）+ `用户工作目录`（产出物，用户自己管理/备份）。
3. **日志 append-only**：会话日志只追加，不原地修改；摘要/长期条目可标记 superseded，不物理删（导出清理除外）。
4. **原子写**：单进程内所有写经 file-store：写临时文件 → rename；防半截文件。
5. **索引可再生**：关键词倒排索引是派生数据，损坏/缺失可一键重建。
6. **路径边界**：所有对外路径存**相对引用**（相对工作目录 or 相对项目文件夹），绝对路径只在运行时解析，保证拷贝迁移语义。

## 2. 顶层数据布局

```
agent_haness/                    # 平台仓库
├── .env                         # 平台配置（2026-09-13 起；此前为 config.yaml）：host/port/模型/数据根/角色库/审批策略默认值
│                                #   命名约定：`__` 分层、数组用 JSON；模板见入库的 .env.example
├── data/                        # 运行时数据根（不入库；DATA_DIR 可改）
│   ├── roles/                   # 【系统角色库】用户自建/修改的模板（内置模板随仓库 src/shared/roles）
│   │   └── <roleId>.yaml
│   └── projects/
│       └── <projectId>/         # 【运行时项目文件夹】＝ 拷贝即迁移的最小单元
│           ├── project.json            # 元数据 + 团队 + 策略（见 §3）
│           ├── runtime.state.json      # 派发运行时态：含 dispatcher occupancy（运行期占用唯一真相，启动重建基线，D18-④）；其余为可重建 cache
│           ├── sessions/
│           │   ├── <sessionId>.meta.json
│           │   └── <sessionId>.log.jsonl     # 会话全量事件日志（append-only）
│           ├── memories/
│           │   ├── global.jsonl              # 项目全局记忆条目
│           │   └── <roleInstanceId>.jsonl    # 角色长期记忆条目（个人）
│           ├── artifacts.jsonl               # 产出物 manifest（相对工作目录路径）
│           ├── file-owners.jsonl             # 产出物署名与归属：relPath → owner/ownerName/时间/次数（§6.1）
│           ├── artifact-versions/            # 版本内容存储：doc=提交快照 / code=补丁（回退依据，见 §6）
│           ├── orchestration.json            # 项目编排图（节点=Agent 实例，边=可委派关系；D19-④，见 orchestration.md）
│           ├── tasks.jsonl                   # 任务委派记录
│           ├── questions.jsonl               # 询问记录（Agent→用户提问与答复；D19-⑦）
│           ├── approvals.jsonl               # 审批队列与历史（含审计）
│           └── search-index/                 # 派生倒排索引（可重建）
└── (用户选定) <workdir>/       # 【项目工作目录 = 唯一产出地】：所有角色产出在此落地并署名
```

> 会话日志/记忆 **永不在工作目录内**（prd 明确要求）；工作目录只被「受控编辑（workdir_edit）/产出物登记/受控命令」触碰；目录内容**全员可读**，写入按文件归属校验（workspaces-artifacts §2）。

## 3. project.json（schema 示例）

```jsonc
{
  "schemaVersion": 1,
  "id": "p_1a2b3c…",
  "name": "todo-app",
  "description": "本地待办清单 Web 应用",
  "createdAt": "2026-09-08T…Z",
  "workdir": "D:/dev/todo-app",          // 绝对路径存记录；迁移到别机时由用户重设(见 §9)
  "workdirKind": "empty | existing-repo",
  "team": [
    {
      "instanceId": "pm_1",
      "roleTemplateId": "pm",
      "displayName": "项目经理",
      "prompt": null,                     // 创建实例时快照模板默认值写入实例；示例以 null 占位。此后模板变更不影响本实例（D16-⑤）
      "model": "deepseek-chat",           // provider id 引用（config.models.providers[].id，口径见 agent-runtime §5）；覆盖模板默认
      "loop": { "strategy": "plan-execute", "params": {} },
      "tools": null,                      // 同上：创建时快照模板默认工具集，可再覆盖（D16-⑤）
      "enabled": true,                    // false = 停用（保留全部数据，D14-9；MVP 每模板至多 1 实例，D14-3）
      "createdAt": "…"
    }
  ],
  "artifactPolicy": { "codeSubmitApproval": false, "docSubmitApproval": true },   // 两扇门：code 门=workdir_edit 任务级聚合；doc 门=静态产物提交(doc/config/deploy 文档/test 报告等)。类型→门映射见 workspaces-artifacts.md §6
  "approvalPolicy": { "highRiskCommands": true }
}
```

## 4. 会话文件

### 4.1 `<sessionId>.meta.json`

```jsonc
{
  "id": "u_pm_1",                       // 用户-角色 1:1 会话：u_<instanceId>（项目内唯一、长期）
  "type": "user",                        // 会话类型（MVP 仅用户↔角色 1:1）
  "projectId": "p_…",
  "participants": { "user": true, "agents": ["pm_1"] },
  "state": "…",                          // 状态枚举（D16-②）：
                                         //   active | suspended(重启恢复期挂起) | archived(实例停用只读,D14-9；重新启用回 active)
                                         // waiting_user 已废弃：审批等待只体现在 Agent 状态 waiting，会话仍 active（见 agent-runtime §2）；
                                         // user suspended 为 occupancy 派生投影（D18-④），可留缓存、非真相源
  "createdAt": "…", "updatedAt": "…", "closedAt": null,
  "lastSeq": 1234,                       // log 已写到的最大序号（跨轮转仍单调，见 §9）
  "segments": [ { "file": "<sid>.log.jsonl", "startSeq": 1, "endSeq": 1234 } ],   // 轮转分段表（M3）
  "summaryRefs": [ { "seq": 101, "summaryId": "s_…", "ofSeq": 1, "toSeq": 100 } ]  // 摘要行索引（memory.md；字段与 §4.2 summary 事件一致）
}
```

### 4.2 `<sessionId>.log.jsonl` —— 全量会话事件（append-only）

一行一个事件对象，schema 字段：

```jsonc
{ "seq": 12, "ts": "2026-09-08T12:00:00.000Z",
  "sessionId": "u_pm_1", "turn": 5,
  "kind": "message", "role": "agent", "sender": "pm_1",
  "content": { "text": "…", "blocks": [] },      // 富文本块（md/artifact/approval 卡片引用）
  "model": "deepseek-chat", "loopStep": "act" }
```

> **单一事件规范（D18-⑤d）**：本表 kind 集为规范事件（kind+payload+scope: session/project/agent）的**存储投影**；同一事件同时驱动 WS 推送（api/contract.md §3）、索引/摘要与前端状态刷新，实现期以统一事件总线为准，不得另起旁路事件词汇。

事件 kind 全集（前端渲染与恢复都依赖它）：

| kind | 说明 | 关键字段 |
| --- | --- | --- |
| `turn_start` | 回合开始（Agent 领活执行一次回复） | turnId, loopStep |
| `turn_end` | 回合正常结束（**中断恢复判定依据：缺此事件=回合未完成**） | turnId, ok |
| `plan` | plan-execute 的计划与执行进度（断点恢复依据） | planId, steps[], stepIndex, status |
| `message` | 可见消息（role: user/agent/system；流结束后完整落盘） | content.text/blocks |
| `thought` | agent 推理过程（默认折叠展示，可展开） | content.text |
| `tool_call` | 工具调用请求 | tool, input(摘要) |
| `tool_result` | 工具结果 | tool, ok, summary(截断) |
| `approval_request` | 审批请求卡片 | approvalId, summary, risk, previewRef?(doc 提交只读预览，D16-⑥) |
| `approval_result` | 审批结果 | approvalId, decision |
| `artifact` | 提交/回退产出物 | artifactId, action |
| `state` | agent 状态切换 | state, sessionId |
| `summary` | 滚动摘要占位（见 memory.md §3） | summaryId, ofSeq, toSeq, digest |
| `error` | 错误/重试 | errorCode, message |

> 每行含 `seq`（会话内**单调且跨轮转连续**，见 §9）；`turn`（该次 agent 回合序号）。恢复=从 0 顺序读 + 摘要跳读。
> **流式文本（D14-⑦）**：`message` 事件只在流式回复结束时整体落盘；流中半截内容不入 log（先推后落），崩溃后以"未完成"标记 + 补全/重说兜底。
> **回合边界（H3 定稿）**：每次 Agent 执行以 `turn_start` 开启、`turn_end` 收尾；中断恢复/未完成判定以"缺 turn_end"为准（memory.md §6）。

## 5. 记忆文件（详见 memory.md）

- `memories/global.jsonl`：项目共享长期条目。
- `memories/<instanceId>.jsonl`：角色个人长期条目。
- 条目行：`{ id, ts, type: fact|decision|preference|commitment|requirement|progress|artifact_index,
  content, source:{sessionId,seq}, tags:[], refs:[artifactId], state: active|superseded }`
- 滚动摘要行**属于会话文件**（`summary` kind 事件）；会话总摘要条目在会话归档后写入上述记忆文件。

## 6. 产出物 manifest（artifacts.jsonl）

### 6.1 产出物署名与归属（file-owners.jsonl，2026-09-12）

```jsonc
{ "relPath": "src/snake.js", "owner": "dev_1", "ownerName": "高级开发",
  "firstAt": "…", "lastAt": "…", "edits": 3, "lastTaskId": "t_…", "via": "workdir_edit|artifact_submit" }
```

- 一行一个文件；`ownerName` 即**署名**（角色显示名）。首次写入即认领；续写累加 `edits` 并刷新 `lastAt`。
- 写前校验（`workdir_edit` / `artifact_submit`）：无主放行、owner=自己放行、**owner=他人 → `ERR_FORBIDDEN`**。
- 写入用**单项目串行锁**（`KeyedLock`）保护，避免并发写丢记录；不做转交（用户选择"只读 + 新建文件"）。
- 读取：`GET /api/projects/:pid/file-owners[?owner=]`；同时注入角色系统提示（我的/他人的产出物清单）。

```jsonc
{ "id": "a_…", "type": "doc|code|config|test|deploy", "title": "PRD v1",
  "summary": "…", "submitter": "pm_1",
  "state": "submitted|approved|rejected|reverted",
  "version": 3,
  "files": [ { "relPath": "docs/prd.md", "action": "add|modify|delete", "hash": "sha256…" } ],
  "diffSummary": { "add": 320, "del": 40 },
  "prevVersion": 2, "approvalId": null, "ts": "…" }
```

- `relPath` 一律相对**工作目录**；文件由角色经 `workdir_edit` 直接写入工作目录后就地登记（无隔离区拷贝步骤）；登记受 `file-owners` 归属校验。
- **版本内容落盘（H2 定稿，回退的内容依据）**：每次提交/聚合把可回退内容写入运行时项目文件夹 `artifact-versions/<artifactId>/v<n>/`：静态产物(doc/config/deploy 等)=各文件提交时**完整快照**；代码(code)=该版本覆盖的受控编辑**补丁**（每文件 diff）。manifest 每条含 `versionDir` 引用；回退=依前序版本内容反向恢复，不依赖 git（workspaces-artifacts.md §3）。
- 代码受控编辑按**任务级**自动聚合生成 artifact 记录（D14-⑧；无任务上下文时按回合兜底，见 workspaces-artifacts.md §2.2）；**无审批门时初始 `state`=approved**（B1 口径，与 workspaces-artifacts §4 状态机一致），仅当策略要求审批时才先 `submitted` 待批；manifest 条目含 `taskId`（归属任务，可为 null）。

## 7. 任务（tasks.jsonl）、询问（questions.jsonl）与审批（approvals.jsonl）

```jsonc
// task（creator：用户经 UI 创建，或**上游 Agent** 沿编排图出边创建（D19-④⑤）；受派者领取后执行）
{ "id": "t_…", "title": "实现登录模块", "desc": "…",
  "creator": "user | pm_1", "assignee": "dev_1",
  "state": "todo|in_progress|done|blocked|terminated", "sessionId": "u_dev_1",
  "artifactIds": [], "ts": "…" }
// 状态流转（2026-09-12 任务栏）：todo=已发布·待领取 → 受派人 task_claim 领取 → in_progress
//   → 受派人 task_update 汇报 done/blocked/terminated；用户与委派人（creator）可干预。
// 通知：create/领取 = 通知受派人「待领取」（系统消息 + 唤醒一轮）；done/blocked/terminated = 通知委派人安排后续。
// 状态变化广播 WS task.updated，任务栏面板实时刷新。
// 撞车去重（2026-09-12）：同 assignee + 归一化标题（去空白/标点+小写）+ 状态∈{todo,in_progress} 视为同一件事，
//   第二次发布不新建（回执点名重复对象）；force=true 可强制新建；终态任务不参与去重。
// 并发安全：tasks.jsonl 的「读全量→改→覆盖写」由**单项目串行锁**保护（通知/结算在锁外，避免自锁）。
// terminated（D17-①）= 显式终止：存在未结算改动时先结算为一条 code artifact 快照再置本状态（可回退）。
// 激活规则（D17-①，修订 D16-④）：每 Agent 至多 1 个 in_progress；已有 in_progress 时**领取/置位被拒**（ERR_CONFLICT，
//   不静默排队开工）；槽位由 done/terminated 释放，释放后平台**只通知**下一条待领取任务，由受派人自行 claim。

// approval（跨进程重启保持 pending；用户决定落盘但不自动回放执行原动作，见 agent-runtime §7）
{ "id": "ap_…", "kind": "command|submit|rollback",  // B2：回退审批也入此表
  "actor": "dev_1", "summary": "执行: rm -rf node_modules", "detail": "…(截断)",
  "previewRef": null,   // doc 类提交审批的只读预览引用（文本预览/文件信息，D16-⑥）
  "status": "pending|approved|rejected|expired", "requestedAt": "…", "decidedAt": null }

// question（Agent→用户提问，D19-⑦；提问即 Agent waiting，同一 Agent 至多 1 个 pending）
{ "id": "q_…", "sessionId": "u_dev_1", "asker": "dev_1",
  "title": "登录方案选哪个？",
  "items": [ { "id": "i_1", "text": "…", "options": ["A","B"], "required": true } ],
  "status": "pending|answered", "answer": { "answers": [ { "itemId": "i_1", "choice": "A" } ], "decidedAt": "…" },
  "createdAt": "…", "answeredAt": null }

// orchestration（编排图，D19-④；schema 见 orchestration.md §2）
{ "schemaVersion": 1, "projectId": "p_…", "version": 3,
  "nodes": [ { "instanceId": "pm_1", "x": 120, "y": 80, "collapsed": false } ],
  "edges": [ { "id": "e_1", "from": "pm_1", "to": "dev_1", "createdAt": "…" } ] }
```

> **双写主从与对账（D18-⑤a）**：approvals/artifacts/tasks 等**业务记录文件先原子写**（成功=事实生效），随后向会话 log 追加对应事件（kind=tool_result/approval_*/artifact/…，审计投影；追加失败记自检告警、不阻断主流程）；启动自检比对 log 尾部并补齐缺失投影。search-index / runtime.state / 会话 meta 标志同理一律视为**可重建投影**，业务状态只以记录文件与 log 事件为准。

## 8. 角色模板（系统角色库）

- 内置：`src/shared/roles/<roleId>.yaml`（随仓库版本，**只读**，升级可覆盖）。
- 用户自建：`data/roles/<roleId>.yaml`（B12/D16-⑤）：内置模板**只读、不可原地改/删**；需变更时在 UI「基于内置复制新建」（新 roleId）。**不存在"同名文件覆盖内置"路径**。
- 模板结构：`{ roleId, name, category, scenario, description, systemPrompt, defaultModel,
  defaultLoop:{strategy,params}, packages:[], tools:[], artifactTypes:[], defaultApprovalRules }`（`scenario` 与 `packages` 为 2026-09-14 新增，见 agent-templates.md / tool-packages.md）。
- 项目内实例配置见 §3 team 数组（prompt/model/loop/tools 覆盖模板）；实例创建时**快照**模板默认值（D16-⑤），此后模板增删改不影响既有实例；`roleTemplateId` 仅作溯源（模板被删除时 UI 标「模板已移除」）。

## 9. 迁移 / 备份 / 损坏恢复

| 场景 | 说明 |
| --- | --- |
| 备份/迁移 | 拷贝 `data/projects/<projectId>/` 即可带走全部会话与记忆；工作目录另行复制或保持同路径。 |
| 换机/换盘 | workdir 绝对路径失效 → 打开项目时提示重设 workdir（project.json 修改一次，记录审计）。 |
| 会话日志损坏 | 逐行容错读（坏行跳过并记 error 事件）；文件过大可归档轮转：≥ 5 万行滚动到 `.log.1.jsonl`。**seq 跨轮转仍单调连续**（M3）：meta `segments[]` 记录每文件起止 seq（`{file, startSeq, endSeq}`），追加/读取/检索跳转都经 segments 解析到具体文件与行偏移，旧文件保留只读。 |
| search-index 损坏 | 删除后重建（提供 `npm run reindex` 或启动时自检）。 |
| runtime.state.json 丢失 | 从 session meta/log 重建 agent 状态（视为 cache，非真相源）。 |
| 半截写 | 原子写保证；异常退出后启动自检未完成临时文件。 |
| 换机重设 workdir（M14 定稿） | 重设后旧 manifest 的 relPath 语义变为相对**新** workdir；下一次提交/回退由提交服务对该批 relPath 重新做存在性与冲突校验（提示用户确认文件映射），不自动改文件。 |

## 10. 检索索引（关键词，MVP）

- 范围：`project 全局`（默认，跨会话/记忆）/ `session 内` / `memory` 过滤。
- 结构：`search-index/<scope>.idx` 为 token → **引用键** `(sessionId|file, seq)` 的映射（简单倒排）；seq 经 meta `segments[]` 解析为"文件+行偏移"（支持轮转，M3），直读 JSONL 行做高亮上下文。
- 更新：事件写 log 时增量 append 索引（同进程内串行，成本可控）；重建接口全量扫。
- 中文分词：MVP 用**二元组(2-gram)+字符**回退，避免引入重型分词依赖；精度不足时换 jieba 类（记扩展点）。
- 向量检索：预留 `semantic/` 目录与 `SearchProvider` 接口（memory.md §8），MVP 不启用。
