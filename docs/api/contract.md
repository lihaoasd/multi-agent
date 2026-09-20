# 接口约定草案 · Agent Haness

> 类别：api · 状态：草稿(待评审) · 决策依据：架构 §10、FR-12；**本文件为草案**，编码阶段以实际实现为准并回写。
> 关联：[ui.md](../design/ui.md)、[data-storage.md](../design/data-storage.md)、[orchestration.md](../design/orchestration.md)、[tool-packages.md](../design/tool-packages.md)、[agent-templates.md](../design/agent-templates.md)、[model-config.md](../design/model-config.md)（模型配置与 Agent 配置提交，2026-09-15）
> 2026-09-15 修订：新增"模型配置"端点组（§2）；删除 `GET/PUT /api/settings/models（config.yaml 落盘）`（与"`.env` 是配置来源"口径冲突的残留，模型路由改由 `/api/model-routing` 承担——该端点已于 2026-09-16 由 S14/D24 删除）；Agent 模板写路径开放提示词/loop/模型三项。
> 2026-09-16 修订（S11/D22）：新增 `DELETE /api/agent-templates/:roleId` 与 `POST /api/agent-templates/bulk-model`；**内置模板开放停用/启用与默认模型**（经 `data/agent-templates-state.json` 覆盖，仓库 yaml 只读），提示词/loop 对内置仍 `ERR_FORBIDDEN`；`GET /api/model-config/overview` 增 `unconfiguredAgents`。
> 2026-09-16 修订（S14/D24）：**删除「默认路由」功能（连机制一起删）**——移除 `GET/PUT /api/model-routing`（请求返回 404）；`GET /api/model-config/overview` 不再返回 `routing` 字段；`GET /api/config` 的 `models` 去掉 `defaultModelId`；生效链收敛为两级（`实例覆盖 → 模板快照`，全空报 `ERR_MODEL`）。

## 1. 约定

- Base：`/api`；JSON 请求/响应；统一错误体 `{ "code": "ERR_XXX", "message": "…" }`（HTTP 状态码仅作粗分类）。
- **客户端请求错误按 4xx 语义返回**（2026-09-15 实现口径）：不支持的 `content-type`、body 过大、JSON 非法等 Fastify 解析错误一律 `ERR_VALIDATION`（404 路由 → `ERR_NOT_FOUND`），**不得报成 `ERR_INTERNAL`**；无参数接口可发空 body（服务端把 `application/json` 的空 body 视为 `{}`）。
- id：全部由服务端生成；时间 UTC ISO-8601。
- 实时：WS `ws://host/ws?projectId=…`，上行 `{type,payload}` / 下行 `{type,payload}`，消息为 JSON 文本帧。
- 安全：本机单用户，无鉴权（绑定 127.0.0.1 默认）。

## 2. REST 端点（草案）

### 项目
| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /api/projects | 项目列表（`index.json` 为派生投影，真源是各项目 `project.json`；结构非法的遗留项目被跳过）|
| POST | /api/projects | 创建（name/description/workdir/members）；`members` 省略 = 全部启用的内置模板（D14-①）；工作目录须"存在 + 目录 + 可写 + 不在平台数据目录内"，否则 `ERR_VALIDATION`；成员实例写入**模板快照**（D16-⑤）|
| GET/PATCH | /api/projects/:pid | 详情 / 改元数据（`name`/`description`；重设 workdir 见 §9 迁移口径）|
| DELETE | /api/projects/:pid | 删除平台数据（只删运行时项目文件夹，**不动用户工作目录**，prd FR-01）|
| GET | /api/fs/browse?path=&depth= | 目录浏览器：**用户级 API，绕过 Agent 沙箱**（本机全盘路径，供创建向导选工作目录；默认过滤/标记系统与隐藏目录、限深度，M8 定稿）。实现口径（2026-09-15）：`path` 必须是绝对路径，省略则返回**根列表**（Windows 为盘符）；返回 `{path,parent,entries[{name,path,isDirectory,isRepo,hidden}],truncated}`，`isRepo`=含 `.git` |
| POST | /api/fs/inspect | 工作目录检查（创建向导用）：`{path}` → `{path,exists,isDirectory,writable,entryCount,kind}`；`kind=empty\|existing-repo`（含 `.git` 或存在可见条目即 existing-repo） |

### 角色库 / 团队
| GET | /api/agent-templates | 模板列表（内置+自定义，含 artifactTypes/tools 元信息）；**`/api/roles` 为同一资源的废弃别名，实施期删除**（2026-09-15 术语收敛为"Agent 模板"）|
| POST | /api/agent-templates | 自建模板（**基于内置复制新建**，B12/D16-⑤）：`{roleId(新 id), copyFrom, name?, scenario?, systemPrompt?, defaultLoop?, defaultModel?}` |
| PATCH | /api/agent-templates/:roleId | 编辑模板的 **提示词 / loop / 模型**（FR-35）；**用户模板**三项均可改（写 yaml + 历史快照）；**内置模板仅 `defaultModel` 可改**（S11：写数据目录覆盖，200），传 `systemPrompt`/`defaultLoop` → `ERR_FORBIDDEN`（提示"基于内置复制新建"），无可提交字段 → `ERR_VALIDATION` |
| DELETE | /api/agent-templates/:roleId?confirm=true | **删除用户模板**（S11/D22）：物理删除 `<roleId>.yaml` 与 `<roleId>.history/`，并清理状态文件残留覆盖，写审计（`scope=template`、`action=delete`）→ `{"deleted":"<roleId>"}`；**内置模板 → 403 `ERR_FORBIDDEN`**（"内置模板只能停用，不能删除"）；缺 `confirm=true` → 400 `ERR_VALIDATION`；被任何项目实例引用 → 409 `ERR_CONFLICT` + `detail.referrers[{projectId,projectName,instanceId,displayName}]`（需先从这些项目移除成员）|
| POST | /api/agent-templates/bulk-model | **批量设置默认模型**（S11/D22）：`{roleIds:string[], defaultModel:string\|null}`（`null` = 清空）→ `{updated:[roleId], skipped:[{roleId,code,message}]}`；内置与用户模板都生效（内置写状态覆盖、用户写 yaml），每个成功项各写一条模板审计；`roleIds` 非字符串数组 / 空数组 / 超过 200 项 → 400 `ERR_VALIDATION`；`defaultModel` 不是已启用模型条目 id 且不是 `null` → 400 `ERR_VALIDATION` |
| POST | /api/agent-templates/:roleId/disable\|enable | 停用/启用模板；**内置模板亦可**（S11：写 `data/agent-templates-state.json` 状态覆盖，仓库 yaml 保持只读，重启/升级后仍生效；此前内置一律 `ERR_FORBIDDEN`）；用户模板写自身 yaml；不影响既有实例（快照，D16-⑤），UI 仅标「模板已移除/已停用」|
| GET | /api/projects/:pid/team | 实例列表+状态 |
| GET | /api/projects/:pid/agents | 团队实时状态投影（state/**waitingFor**/sessionId/**currentTask**；左栏与画布用；**S38/D41**：`waitingFor`＝`question`（等用户答复询问）/`approval`（等审批）/`null`；**S51/D54**：`currentTask`＝`{id,title,state}`（该角色 `in_progress` 任务，无则 `null`——会话顶部「正在执行」标签用它））；**S2 阶段 `state` 恒为 `idle`，dispatcher 于 S3 接管** |
| GET | /api/projects/:pid/agents/:iid | **角色详情**（只读）：身份/模型/loop/提示词/工具 + 实时状态；工具按**运行期口径**给出（`effective` 带 `whitelist`/`platform` 来源，`unavailable` 为白名单里配了却用不上的，无 `availableIn` 即注册表里已没有）；实例不存在 → 404 `ERR_NOT_FOUND` |
| GET | /api/projects/:pid/agents/:iid/system-prompt | **完整系统提示词预览**（只读）：与运行期**同一 ContextBuilder** → `{ sessionType:"user", blocks:[{id,origin,title,text}], text }`；块顺序 `role-config`（实例提示词）→ `platform-role` → `global-memory` → `role-memory` → `session-window`（含最近滚动摘要）→ [`retrieval`（有检索片段时）] → `tools`（S5 起记忆块已接入；S6 再追加任务/产出索引段）；不落盘；实例不存在 → 404 |
| POST | /api/projects/:pid/team | 增实例（选模板+覆盖配置）；**每模板至多 1 实例**（D14-3，重复 → `ERR_CONFLICT`）；创建时**快照模板默认值**（D16-⑤） |
| PATCH | /api/projects/:pid/team/:iid | 改实例：`displayName` / `prompt` / `model` / `loop` / `enabled`；**传 `null` 表示清除覆盖回到快照**；仅覆盖变化时 `configVersion+1`；校验复用模板层同一套（提示词长度、loop 参数范围、模型须已启用） |
| GET | /api/projects/:pid/team/:iid/effective-config | 有效配置解析结果（两级：实例覆盖 → 模板快照；S14/D24 起无平台默认模型，两级皆空时 `model` 为 `null`） |
| DELETE | /api/projects/:pid/team/:iid | **停用实例**（保留会话/记忆，可重新启用，D14-9）；重复停用 → `ERR_CONFLICT` |
| POST | /api/projects/:pid/team/:iid/enable | 重新启用（无 body；服务端把空 body 视为 `{}`） |

### 会话 / 消息
| GET | /api/projects/:pid/sessions | 会话列表（每实例 1 条 `u_<instanceId>`；含 `state`/`lastSeq`/`lastMessagePreview`）|
| GET | /api/projects/:pid/sessions/:sid | meta + 事件窗口（`?limit=` 尾窗语义，默认 200）|
| POST | /api/projects/:pid/sessions/:sid/messages | 发送用户消息（body:`{text}`）→ **202** `{seq, queued}`；`queued=true` 表示该 Agent 忙或已暂停、消息已入队（队列 = 日志中未处理消息）；实例停用 → `ERR_CONFLICT` |
| GET | /api/projects/:pid/sessions/:sid/log?fromSeq=&kind=&limit= | 增量拉日志（重连恢复）；`kind=` 逗号分隔过滤（原始事件时间线视图）|
| POST | /api/projects/:pid/agents/:iid/pause | **暂停**：给该 Agent 置暂停状态、不再领新任务；**S49/D52**：**不切断在途模型调用**——当前这一轮 loop 跑完即停止循环（每轮开始处判断），被中断的消息**留在队列**（游标不推进），`resume` 补处理；重复暂停 → `ERR_CONFLICT` |
| POST | /api/projects/:pid/agents/:iid/resume | 恢复并**立刻补处理排队消息** → `{...status, handled}` |
| POST | /api/projects/:pid/dispatcher/resume-queued | 项目级恢复入口：给"队列非空且无占用且未暂停"的 Agent **各排一次** drain（D18-③）→ `{resumed:[instanceId]}`（**S47/D50 起为"已排"**，不等待回合跑完：某个 Agent 卡在等答复时不再挡住其它 Agent） |
| POST | /api/projects/:pid/sessions/:sid/hangup | user 会话：暂停 Agent（P1）|

> 会话与事件口径（2026-09-15 实现）：事件**先落盘后推送**（`EventPipeline` 是唯一写入口）；`GET .../log` 返回 `[{seq,ts,sessionId,turn,kind,...payload}]`；seq 会话内单调且**跨轮转连续**（轮转段命名 `<sid>.log.<n>.jsonl`，当前段恒为 `<sid>.log.jsonl`）。

### 产出物 / 任务 / 审批 / 搜索
| GET | /api/projects/:pid/artifacts?type=&submitter=&state=&taskId=&limit= | manifest 列表（每个 artifact 只回最新版本）。实现（2026-09-15，S6）：条目含 `id/type/title/summary/submitter/state/version/files[{relPath,action,hash}]/diffSummary/prevVersion/taskId/revertedTo/ts`；**S54/D58** 起回退版本另含 `revertMode`（`undo`\|`restore`\|`null`，旧数据缺省 `undo`） |
| GET | /api/projects/:pid/artifacts/:aid | 详情（文件清单/diff 摘要）|
| GET | /api/projects/:pid/artifacts/:aid/versions | 该 artifact 的全部版本（版本号升序；回退产生 `state=reverted` + `revertedTo` + `revertMode` 的新版本）|
| POST | /api/projects/:pid/artifacts/:aid/rollback | 回退到指定版本 `{version, mode?, force?}`（**S54/D58** 加 `mode`）：`undo`（缺省）＝把该版本涉及文件恢复为其提交前内容（新增文件即删除）；`restore`＝把文件恢复成该版本的**内容**（等于撤销它之后的所有版本）；`mode=restore` 且目标已是最新 → `ERR_VALIDATION`。文件在目标版本后被改动过 → `ERR_CONFLICT` + `detail.conflicted[]`，确认覆盖需 `force=true` |
| GET/POST | /api/projects/:pid/tasks | 任务列表（可按 state/assignee/creator 筛）/ 发布任务（`todo`=已发布待领取，落库后通知受派人）；**同受派人+同题活跃任务自动去重**：新建 201，命中重复 200 `{task, duplicate:true}`，`force:true` 强制新建 |
| PATCH | /api/projects/:pid/tasks/:tid | 改状态 `{state, note?}`（状态含 `terminated`=用户终止，先结算未结算改动为 code artifact，D17-①；已有 in_progress 时置新 in_progress 返回 ERR_CONFLICT）；done/terminated 会通知委派人；**S53/D57**：`blocked` 不再被接受（`ERR_VALIDATION`），历史 `blocked` 记录仍可读可筛 |
| GET | /api/projects/:pid/file-owners?owner= | 产出物**署名与归属**列表（relPath/owner/ownerName/时间/次数），2026-09-12；实现（S6）另含 `lastTaskId`/`via`（`workdir_edit`\|`artifact_submit`）|
| GET | /api/projects/:pid/pending-edits?key= | 未结算改动（任务级聚合视图）：`{edits[], files, diffSummary}`；`key=task-<taskId>` 或 `turn-<sessionId>-<turn>` |
| GET | /api/projects/:pid/questions?status=pending\|answered&sessionId= | **询问列表**：Agent 向用户提问（一条记录含 `items[]`；`pending`=待答）；Agent 提问后状态 `waiting`，同一 Agent 至多 1 个 pending（再问 → `ERR_QUESTION_PENDING`）|
| POST | /api/projects/:pid/questions/:qid/answer | 答复询问：`{answers:[{itemId, choice?/text?}]}`；必答项缺失 → `ERR_VALIDATION`（`detail.missing[]`）、重复答复 → `ERR_CONFLICT`；答复后唤醒该 Agent 继续（无排队提问时）|
| GET | /api/projects/:pid/approvals?status=pending\|approved\|rejected&actor= | 审批列表（按请求时间倒序）|
| POST | /api/projects/:pid/approvals/:apid/decide | 批准/拒绝 `{decision:"approved"\|"rejected", reason?}`；**决定只能落一次**（重复 → `ERR_CONFLICT`）；落盘后唤醒等待中的回合（approved 继续执行 / rejected 回注 `ERR_APPROVAL_REJECTED`）|
| GET | /api/projects/:pid/search?q=&scope=\|type=&sessionId=&limit= | 关键词检索（会话/记忆分组）。实现（2026-09-15，S5）：`scope` 与 `type` 同义（`all\|session\|memory`），2-gram 中文匹配 + 汉字单字回退；返回 `{query,count,sessionHits[],memoryHits[]}`，命中带 `(sessionId,seq)` 或 `entryId`、`kind`、`score`、`tokens[]`（供高亮与跳转）。用户视角不受可见性限制 |
| GET | /api/projects/:pid/search/stats | 索引规模（派生投影）：`{documents,tokens,builtAt}` |
| POST | /api/projects/:pid/search/reindex | 全量重建该项目索引（与 `npm run reindex` 同源；结果同上） |
| GET | /api/projects/:pid/memories?scope=global\|agent&instanceId=&type=&state=&limit= | 记忆列表（只读浏览，M13；P1 支持钉住/编辑/删除 FR-19）。实现（S5）：返回 `{entries[],count}`，条目含 `id/ts/scope/instanceId/type/content/source{sessionId,seq}/tags/refs/state/supersededBy`；`type`/`state` 非法 → `ERR_VALIDATION` |

### 编排图（2026-09-15，S7）
| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /api/projects/:pid/orchestration | 读取编排图；**按当前团队归一化**：补齐缺失实例节点（网格默认位）、级联删除已移除实例的节点与边、丢弃自环边；文件缺失/损坏 → `version=0` 空图。返回 `{schemaVersion,projectId,version,updatedAt,updatedBy,nodes[{instanceId,x,y,collapsed}],edges[{id,from,to,createdAt}]}` |
| PUT | /api/projects/:pid/orchestration | **全量保存** `{version, nodes, edges}`：`version` 不匹配 → `ERR_CONFLICT`（`detail.currentVersion`）；自环/重复边/跨项目或未知实例/边端不在图中 → `ERR_ORCHESTRATION_INVALID`；缺 `version`/结构非法 → `ERR_VALIDATION`；成功 `version+1` 并广播 `orchestration.updated`；只有用户能编辑图 |

### 运行控制与恢复（2026-09-15，S8）
| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /api/projects/:pid/runtime | 运行细条：`{working[{instanceId,displayName,state,waitingFor,paused,queued,sessionId,turn,startedAt,taskTitle,planStatus}],idle,paused,queuedTotal}`（占用来自 `runtime.state.json`，只列非 idle；**S21 起不再有 `unfinishedTurn`**） |
| POST | /api/projects/:pid/agents/:iid/stop | `{scope:'turn'\|'task'}`：`turn`=停当前回合输出（队列保留）；`task`=终止当前任务（**先结算未结算改动**为 code artifact）→ `{aborted,taskId,settledArtifactId,queued}`；非法 scope → `ERR_VALIDATION` |

> **S21/D27（2026-09-16）删除的接口**：`GET /api/projects/:pid/recovery`、`GET /api/projects/:pid/sessions/:sid/recovery`、`POST /api/projects/:pid/sessions/:sid/recovery`（原"三选 + 补全"）。
> 未完成回合不再由平台判定，改由 Agent 自查会话事件（工具 `session_recent`）后用 `ask_user` 询问用户；旧的 `state` 恢复标记不再被消费。三条路径现在返回 **404**。

### 系统
| GET | /api/config | 运行期只读总览：存储根/`roleDirs`、`server`、`models`（配置文件/遗留导入开关/提示词上限/超时）、`approval`、`sandbox`、`search`、`context` 上限与备份口径；**模型与供应商部分已迁出**（见「模型配置」组），**永不含密钥**（S9 落地）；**S14/D24 起 `models` 不再含 `defaultModelId`** |
| GET | /api/projects/:pid/export | 导出运行时项目文件夹为 zip（会话/记忆/产出物/归属/任务/询问/编排图，附 `EXPORT-README.txt`；**不含用户工作目录**）。实现（S8）：零依赖 STORE 写入器；响应 `application/zip` + `attachment; filename="<pid>.zip"`；项目数据不存在 → 404；超 64M 字符 → `ERR_VALIDATION` |

### 模型配置（2026-09-15 新增，设计见 [design/model-config.md](../design/model-config.md)）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /api/model-presets | 预置供应商目录（9 家：kind/默认 baseUrl/凭证提示/建议模型/文档链接，**不含密钥**）|
| GET | /api/model-providers | 供应商列表（`credential` 只回 `{mode, envName?, hasValue, masked}`）|
| POST | /api/model-providers | 新建：`{presetId?}` 走预置模板，或 `{id, name, kind, baseUrl, credential, headers?, timeoutMs?}` 自定义 |
| PATCH | /api/model-providers/:pid | 编辑（`credential` 省略=保持原值；`""`=清除）；改 `kind` 必须同时给 `baseUrl` |
| DELETE | /api/model-providers/:pid | 删除；其下存在模型条目 → `ERR_CONFLICT` + `detail.referrers` |
| POST | /api/model-providers/:pid/test | 连通性测试 `{mode:"models"\|"chat", modelId?}` → 成功 `{latencyMs, models?}`（失败走统一错误体）；不写会话日志 |
| GET | /api/model-providers/:pid/discover | 拉取供应商可用模型名 → `{models:[…]}`；不支持/失败 → `ERR_MODEL`（UI 提示手工填写，不阻断）|
| GET | /api/models | 模型条目列表（含供应商摘要、能力、启用状态、被引用者标签 `referrers[]`）|
| POST | /api/models | 新建模型条目 `{id, providerId, model, displayName?, capabilities?, contextWindow?, maxOutputTokens?, defaultParams?}` |
| POST | /api/models/bulk | 批量登记 `{providerId, models:[{model, displayName?}]}` → `{created:[…], skipped:[…]}`（同供应商同名跳过；id 由 `<providerId>-<模型名>` 归一化且唯一）|
| PATCH | /api/models/:mid | 编辑（含 `enabled`）；停用**被模板/实例引用**的模型需 `confirm:true`，否则 `ERR_CONFLICT` + `detail.referrers` |
| DELETE | /api/models/:mid | 删除；被引用时需 `?confirm=true`，否则 `ERR_CONFLICT` + `detail.referrers`（S14/D24 起不再有需要连带清理的默认模型/路由指向） |
| GET | /api/model-config/overview | 一次取回 `{revision, providers[], models[], notices[], unconfiguredAgents}`（UI 首屏用；**S14/D24 起不再有 `routing` 字段**）；`unconfiguredAgents = {total, items:[{projectId, projectName, instanceId, displayName}]}`，口径 = 项目实例中 **enabled 且生效模型为空**（生效链两级 `实例覆盖 → 模板快照`，S11/D22、S14/D24）；`notices` 为 v0/坏文件备份与 `routing-removed`（遗留 `routing` 键已丢弃、待启动回写抹除）提示 |
| POST | /api/model-config/import | 一次性导入遗留配置 `?source=env\|v0`（`.env` 的 `MODELS__PROVIDERS` / 旧 `data/model-config.json`）→ `{imported, skipped[]}` |

> 校验与失败语义见 model-config.md §8：**不新增错误码**，沿用 `ERR_VALIDATION`/`ERR_CONFLICT`/`ERR_NOT_FOUND`/`ERR_FORBIDDEN`/`ERR_MODEL`；引用者列表放 `detail.referrers`。
> 启动初始化（model-config.md §11；**S14/D24 修订**）：① **抹掉已废弃的 `routing` 键**——加载时丢弃，启动流程回写配置文件并从磁盘抹除，写 `config-audit`（`action:"migrate"`、`target:{kind:"routing",id:"removed"}`、`diff:{removed:["routing"]}`）；② **迁移**——剔除 `kind` 已不在注册表中的供应商及其模型条目并写 `config-audit`；③ 空配置且允许时一次性导入遗留 `MODELS__PROVIDERS`；④ **不自动创建任何供应商/模型，也不再有 `MODELS__DEFAULT`**（未配置模型的 Agent 启动回合报 `ERR_MODEL` 并给出配置引导：在「模型」模块添加供应商与模型条目，并在 Agent 模块或项目内为它选择模型）。

### 首页库（工具包只读；Agent 模板：用户模板开放 提示词/loop/模型 三项提交，内置仅默认模型可改、可停用，S11）| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /api/tool-packages | 工具包列表（含 `tools[]` 展开、`required`、`source`、`riskMax`）；每个工具带 `registered`（**展示态 vs 生效态**：已声明但当前版本未注册的工具标"未实现"）|
| GET | /api/tool-packages/:packageId | 单包详情（含每个工具的作用/风险/网络/幂等/适用会话）|
| GET | /api/tools | 已注册工具清单（名/包/风险/网络/是否需审批/幂等/适用会话）|
| GET | /api/loops | 已注册 loop 策略（名 + 说明）|
| GET | /api/agent-templates?scenario= | Agent 模板列表（含 loop/模型/工具包/场景标签摘要、`defaultModelAvailable`、`editable`（提示词/loop 可改，内置恒 false）、`modelEditable`（默认模型可改，内置亦为 true）、`deletable`（仅用户模板）；写路径同"角色库/团队"表，S11）|
| GET | /api/agent-templates/:roleId | 模板详情（身份/loop/**系统提示词预览**/工具按包展开/模型/审批规则）|
| GET | /api/agent-templates/:roleId/history | 模板配置历史快照文件名列表（只增；仅用户模板有）|

> 2026-09-15 更新：Agent 模板的**提示词 / loop / 模型**已开放提交（FR-35，写路径见"角色库 / 团队"表）；**工具包制作（U8）仍只读**。
> 2026-09-16 更新（S11/D22）：**内置模板的提示词/loop 仍只读**（`ERR_FORBIDDEN`），但**默认模型可改、可停用/启用**（写 `data/agent-templates-state.json` 覆盖，仓库 yaml 不被改写）；**模板删除仅对用户模板开放**（内置只能停用），删除需 `confirm=true` 且被项目实例引用时 409 + `detail.referrers`；新增 `DELETE /api/agent-templates/:roleId` 与 `POST /api/agent-templates/bulk-model`。
> 项目内实例覆盖走 `PATCH /api/projects/:pid/team/:iid`（字段 `prompt`/`loop`/`model`，校验见 model-config.md §8 #11/#12）。

### 项目编排（拓扑图）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /api/projects/:pid/orchestration | 读取编排图（`nodes[]`/`edges[]`/`version`）|
| PUT | /api/projects/:pid/orchestration | **全量保存**（body 带 `version` 做乐观并发）；校验自环/重复边/节点属本项目，失败返回 `ERR_ORCHESTRATION_INVALID`；版本不匹配返回 `ERR_CONFLICT` |

### Agent 运行控制

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | /api/projects/:pid/agents/:iid/pause | **暂停**：不再领新任务；**当前这一轮 loop 跑完即停**（不切断在途模型调用）、游标不推进（恢复后补处理队列）|
| POST | /api/projects/:pid/agents/:iid/resume | 恢复：继续处理队列 |
| POST | /api/projects/:pid/agents/:iid/stop | （**S49/D52：界面已无入口，供脚本/兜底**）`scope:'turn'`＝**停止生成**：abort 在途调用、本条消息作废、剩余队列不自动续跑；`scope:'task'`＝**停止任务**（带确认；存在未结算改动先结算为 code artifact 快照）。返回 `{aborted, taskId, settledArtifactId, queued}`，无在途回合时 `aborted=false` |

## 3. WS 协议

连接：`GET /ws?projectId=<pid>`（带 projectId 即自动订阅该项目；也可连接后用 `subscribe` 上行补订阅）。

上行（客户端→服务）：
```
{ type:"ping" }                                               // → 下行 pong
{ type:"subscribe", payload:{projectId} }                      // 订阅项目（连接时已带 projectId 则无需再发）
{ type:"send", payload:{projectId, sessionId, text} }          // 发送消息（等价 REST 发消息）
{ type:"ack", payload:{seq} }                                  // UI 已渲染到 seq（服务端据此算未读，P1）
```

下行（服务→客户端）事件：
```
{ type:"ws.ready", payload:{clientId, projectId} }            // 连接就绪（订阅生效）
{ type:"pong", payload:{ts} }
{ type:"subscribed", payload:{projectId} }
{ type:"message.accepted", payload:{sessionId, seq, queued} }  // 上行 send 的回执
{ type:"session.updated" }            // meta 变化（状态/未读基线）
{ type:"message.chunk", payload:{sessionId, turnId, seq, delta} }   // 流式增量（S4 起，由 ModelGateway 驱动）；**S42/D45 起会话窗口消费它**：用于输入框上方"模型正在输出…"提示（暂不渲染增量文本）。⚠️ **S48/D51**：该帧频率可达 100+/秒，前端**不得**把它写进 React state（只做节流计数/标志），否则整页按帧重渲染会卡死
{ type:"message.commit", payload:{sessionId, seq} }                 // 该消息落盘完成（先盘后推）
{ type:"agent.state", payload:{projectId, instanceId, state, sessionId} }
{ type:"team.updated", payload:{projectId, instanceId, action} }            // 实例增删停启/配置覆盖（D14-9）
{ type:"orchestration.updated", payload:{projectId, version} }        // 编排图保存（画布同步刷新）
{ type:"model-config.updated", payload:{revision, changed:{kind:"provider"|"model", id}} }  // 供应商/模型变更（2026-09-15；S14/D24 起不再有 routing 变更）
{ type:"agent-config.updated", payload:{scope:"template"|"instance", roleId?, projectId?, instanceId?, configVersion} }  // Agent 配置提交（2026-09-15）
{ type:"task.updated", payload:{taskId, action, state, assignee, creator, title} }  // 任务栏：发布/领取/状态变化（2026-09-12）
{ type:"event.appended", payload:{projectId, sessionId, seq, kind, ts}}            // 事件已落盘并追加（含回合边界）
{ type:"approval.requested", payload:{projectId, approval:…}}   // 审批落盘后广播（Agent 转 waiting）
{ type:"approval.decided", payload:{projectId, approval:…}}     // 用户决定后广播
{ type:"artifact.updated", payload:{artifactId, state}}
{ type:"question.asked", payload:{questionId, asker, kind, question, options, record}}  // Agent 提问：右栏询问列表新增待答项，Agent 转 waiting
{ type:"question.answered", payload:{questionId, asker, answer}}                       // 答复：撤卡/列表项转已答，Agent 继续
{ type:"error", payload:{code, message}}
```

顺序保证：同会话事件按 seq 单调下发；`message.commit` 表示该条已落盘（先盘后推，见 memory.md §2）。
**广播路由（2026-09-15 实现）**：事件 payload 带 `projectId` → 只发给订阅该项目的连接；不带 → 全局事件发给所有连接（如 `model-config.updated`）。

> 事件规范（D18-⑤d）：本节 WS 下行事件是规范事件（data-storage.md §4.2 单一事件规范）的 **UI 投影**，与 log kind 一一对应，实现期不得另起旁路事件词汇。

## 4. 错误码（草案）

API 统一返回 `{ code: ERR_*, message }`。工具执行/审计事件内部用简码（`FS_BOUNDARY`/`APPROVAL_REJECTED` 等，见 sandbox.md §8），二者映射如下（M9 定稿：一套语义、两套编码，事件/审计中保留简码，REST 统一 ERR_*）：

| API code | 含义 | 内部简码 |
| --- | --- | --- |
| ERR_NOT_FOUND | 资源不存在 | — |
| ERR_CONFLICT | 状态冲突（Agent busy / 任务槽位被占 / 非法状态流转） | — |
| ERR_FORBIDDEN | **归属/只读限制**：该文件/产出物属他人（署名与归属锁，2026-09-12）；内置 Agent 模板的提示词/loop 修改与删除（只读，只能停用，S11） | — |
| ERR_FORBIDDEN_PATH | 路径越界 | FS_BOUNDARY |
| ERR_APPROVAL_REQUIRED | 动作需审批（返回 approvalId） | APPROVAL_REQUIRED |
| ERR_APPROVAL_REJECTED | 审批被拒（回注 Agent） | APPROVAL_REJECTED |
| ERR_CMD_TIMEOUT | 命令超时被杀 | CMD_TIMEOUT |
| ERR_CMD_FORBIDDEN | 命令被禁（长驻/daemon/交互） | CMD_FORBIDDEN_DAEMON |
| ERR_NET_OFFLINE | 离线模式禁止联网动作 | NET_OFFLINE |
| ERR_VALIDATION | 参数/边界校验失败 | — |
| ERR_MODEL | 模型调用失败（含供应商/模型未配置、被停用、凭证缺失、调用超时；`detail` 含 `{providerId, modelId, status?, message}`，**已脱敏**） | — |
| ERR_ORCHESTRATION_EDGE | 越权委派：目标不是本 Agent 的出边节点（Agent 发起时） | — |
| ERR_ORCHESTRATION_INVALID | 编排图非法：自环 / 重复边 / 节点不属于本项目 | — |
| ERR_QUESTION_PENDING | 该 Agent 已有待答询问（同一时刻至多 1 个） | — |
| ERR_TOOL_REJECTED | 工具被策略拒绝 | — |
| ERR_INTERNAL | 内部错误（审计信息入日志） | — |
