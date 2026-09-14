# Agent 工具设计 · Agent Haness

> 类别：design · 状态：草稿(待评审) · 决策依据：D11/D12/D13、prd FR-13、US-3/12
> 关联：[sandbox.md](sandbox.md)（执行安全）、[agent-runtime.md](agent-runtime.md)（loop/工具概要）、[data-storage.md](data-storage.md)（事件日志）

## 1. 目标与原则

- **工具是 Agent 影响外部世界的唯一通道**（消息输出与记忆写入之外的受控动作都必须是工具调用）；不存在"隐藏的后门工具"。
- **先声明后调用**：每个工具向模型只暴露 schema（name/description/参数 JSON Schema/是否幂等/预期副作用），不暴露实现。
- **最小可用集**：只把该角色启用的工具 schema 放进提示词（省 token、防误调），禁用工具一律不可见不可调。
- **全量留痕**：每次 tool_call / tool_result 都以会话事件落盘（审计、恢复、界面展开）。
- **失败结构化**：错误返回 `{ ok:false, code, reason }`，不回传裸堆栈，引导 Agent 调整。
- **写工作目录只有三条受控通道**（见 §6），工具层不存在自由写 workdir 的文件工具。

## 2. 工具注册表与元数据

工具在应用启动时注册到 `tool-registry`（扩展点 `registerTool(def)`）。定义：

```jsonc
{
  "name": "cmd_run",                        // 规范命名：<域>_<动作>，全局唯一
  "package": "cmd",                         // 所属工具包（见 tool-packages.md；启动自检校验包内一致）
  "description": "在项目工作目录内执行命令（结构化参数，非自由 shell）",
  "category": "exec",
  "paramsSchema": { /* JSON Schema */ },
  "scope": "workdir",                        // workdir | readonly-global | platform
  "risk": "low",                             // none | low | high（叠加审批规则后生效）
  "network": "allowed",                      // none | allowed | outbound_high（见 sandbox.md §6）
  "needsApproval": "(rule)",                 // 规则函数/引用名，缺省取 risk
  "idempotent": false,                       // 可否安全自动重试
  "timeoutMs": 60000,
  "availableIn": ["user"],                   // 会话类型可用性（MVP 仅 user 会话）
  "allowedRoots": ["workdir", "ro"],         // 工具级可用根收窄（B4，L0 是底线）：fs_*=[workdir,ro://]；写入仅 workdir 且受归属校验；见 sandbox.md §3.2
  "output": { "maxChars": 12000, "strategy": "truncate-tail|summarize|raw" }
}
```

- **统一策略引擎（D18-⑥）**：`needsApproval` 与 sandbox L2 命令风险表、project.json 策略、信任开关（D17-④）同属 **PolicyEngine** 的数据源；判定输入 (actor, sessionType, tool/command, params, projectPolicy, trust) → allow/approval/deny + ruleId，优先级 **deny > approval > allow**（实现口径见 sandbox.md §5.1）。
- 命名规范：`fs_*`（文件）/`cmd_*`（命令）/`memory_*`（记忆）/`session_*`（会话检索）/`artifact_*`（产出物）/`approval_*`（审批）/`task_*`（任务，D15 默认关闭）。
> 说明：早期文档中的工具简写（read_file 等）已于 2026-09-08 全库同步为本规范命名（见 docs/changes 修改记录）。

## 3. 工具分类与内置清单（MVP）

| 工具 | 作用 | scope/risk/network | 幂等 | 会话可用 |
| --- | --- | --- | --- | --- |
| `fs_read_file` | 读文本文件（workdir+ro://，可 range；**工作目录全员可读**） | readonly-global / none | ✅ | user |
| `fs_list_dir` | 列目录（workdir+ro://） | readonly-global / none | ✅ | user |
| `fs_search` | 目录内关键词搜索（workdir+ro://） | readonly-global / none | ✅ | user |
| `workdir_edit` | **项目工作目录唯一写通道**（单文件、留 diff 审计、**署名 + 归属校验**：他人产出物拒改） | workdir / low | ❌ | user only |
| `cmd_run` | 在 workdir 内执行命令（结构化 argv，沙箱见 sandbox.md） | workdir / 按命令 / allowed | 视命令 | user only |
| `artifact_submit` | 把项目目录里已写好的文件**登记为产出物**（版本快照 + manifest + 署名），不移动文件 | workdir / low | ❌ | user only |
| `artifact_rollback` | 回退产出物版本（服务接口保留；2026-09-09 起无 UI 入口） | workdir / high | ❌ | user only |
| `memory_search` | 检索记忆（角色+全局，按权限） | readonly-global / none | ✅ | user |
| `memory_append` | 追加长期记忆条目（scope=own 默认） | platform(记忆) / none | ✅ | user(仅 own) |
| `session_search` | 关键词检索本项目会话日志（受 Agent 可检索集约束，D18-②） | readonly-global / none | ✅ | user |
| `approval_query` | 查看自己触发的审批状态 | platform / none | ✅ | user only |
| `ask_user` | 向用户提问（question/options）并阻塞等待答复（Agent 转 waiting） | platform / none | ❌ | user only |
| `task_view`/`task_list` | 查看任务（本人/项目） | platform / none | ✅ | user（平台常驻） |
| `task_assign` | **发布任务到任务栏**（目标必须是本 Agent 在编排图中的**出边节点**，D19-④；平台随即通知受派人；同题自动去重，`force` 可强制） | platform / none | ✅ | user only |
| `task_claim` | **领取**任务栏上派给自己的任务（缺省领最早一条；todo→in_progress） | platform / none | ❌ | user only |
| `task_update` | 更新任务状态/汇报（开工/完成/受阻/终止；done 后平台通知委派人） | platform / none | 分动作 | user only |

说明：
- `approval_request` 不列为模型工具：审批由执行器在工具命中 high/策略时自动产生（见 sandbox.md §5），Agent 无需也不能"替用户批准"。
- **`ask_user` 是 Agent 向用户提问的唯一通道**：调用即 Agent `waiting`，右栏询问列表答复后继续；同一 Agent 至多 1 个待答（`ERR_QUESTION_PENDING`，D19-⑦）。
- **工具包（D19-②）**：7 个基础包 `fs`/`cmd`/`memory`/`session`/`artifact`/`approval`/`task` **全员必选**；下表角色矩阵仍是**工具级授权真源**，包只是展示与未来挂载单位（见 tool-packages.md）。
- **可用根（B4 定稿）**：`fs_*` 的 allowedRoots=[workdir, ro://]；`workdir_edit`/`artifact_submit` allowedRoots=[workdir]。**所有产出都在项目工作目录内进行（无私有工作区）**：目录内容**全员可读**，写入一律经 `workdir_edit` 并按 `file-owners` 校验归属（只有归属自己的文件可改，详见 workspaces-artifacts.md §2）。loop runner 的工具可用性校验 = 角色白名单 × 会话类型 × allowedRoots，与 sandbox §3.2 的工具级可用根一致。
- **任务工具（D15 → 2026-09-12 任务栏）**：`task_assign/task_claim/task_update` 为**平台工具**，user 会话始终可用（不依赖角色模板快照）：`task_assign` 内部校验角色（仅 pm/product）→ 发布任务到任务栏（state=todo 待领取）+ 通知受派人；受派人 `task_claim` 领取（只能领自己的，槽位检查）→ in_progress；`task_update` 由受派人汇报，done/blocked/terminated 会通知委派人安排后续。状态变化同步推 WS `task.updated`。
- 用户直接操作（右栏回退按钮、任务状态、停用实例等）不经工具注册表。

## 4. 角色模板 ↔ 工具默认矩阵（内置模板，可覆盖）

能力按"组"配置（enable/disable），实例可在项目内调整（tools 字段覆盖的是**创建实例时的模板快照**，D16-⑤）。

| 能力组 | pm | product | architect | ux | ui | dev | qa | ops |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| 调研读取（fs_read/fs_list/fs_search/session_search） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 记忆（memory_search/memory_append-own） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 工作目录编辑（workdir_edit，**唯一写通道**） | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅¹ | ✅ |
| 命令执行（cmd_run，按 sandbox 风险审批） | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅¹ | ✅ |
| 产出物登记（artifact_submit，署名+快照） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 回退请求（artifact_rollback，审批） | ✅(自己的) | 同上 | 同上 | 同上 | 同上 | ✅ | ✅ | ✅ |
| 任务（task_*） | ✅³ | ✅³ | ✅³ | ✅³ | ✅³ | ✅³ | ✅³ | ✅³ |
| 全局记忆写入（memory_append scope=global） | ✅² | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

¹ qa 执行测试命令与写自动化测试文件；如需改业务代码由 dev 或授权后做。
² 仅 pm 可登记任务/进度/里程碑类全局条目；决策类全局写入由引擎自动完成（memory.md §4），不通过工具。
³ `task_*` 为**平台工具**，user 会话常驻、不依赖角色模板授权；`task_assign` 的目标须是本 Agent 在编排图中的出边节点（D19-④）。

设计理由：
- 编辑能力默认只给"需要真机验证"的角色（dev/qa/ops）；**2026-09-12 起 productive 角色（product/architect/ux/ui）也获得 `workdir_edit`**——产出必须直接落项目目录，pm 仍无写权限（只协调不产出）；
- 全员都可登记自己的产出物（文档/设计稿/测试报告/部署脚本都在各自职责内），且**只能登记/修改自己名下的文件**（署名与归属锁见 workspaces-artifacts.md §2.3）；
- 角色"默认零执行权限，按需授权"是可扩展方向：非开发角色遇到需要跑命令的任务，应把需求交给 dev/ops 或请用户在实例配置中临时启用（决策写记忆）。
- **任务行（D15 → D19-④⑤）**：`task_*` 常驻；Agent 委派为默认，且**只能派给编排图出边节点**，受派者 `task_claim` 领取后执行；用户手动派单不受边约束。

## 5. 调用协议与回合事件

回合内调用序列（与 loop 引擎集成，详见 agent-runtime.md §7）：

```
loop 步骤 → 模型输出 tool_call{callId, name, args}
  → executor 校验链：①已注册 ②角色启用(白名单) ③会话类型可用 ④风险/审批判定 ⑤路径边界(sandbox L0)
  → 通过：执行 → 产出 tool_result 事件 {callId, ok, summary(截断), dataRef?}
  → 命中审批：产生 approval_request 事件 → Agent 状态 waiting → 用户决定 → tool_result(含 decision) 回注
  → 拒绝/越界：tool_result{ok:false, code, reason} 回注，Agent 调整方案
```

- 输出处理：大结果一律截断 + `…(已省略，可用 fs_read_file range 读取)`；命令输出保留尾部（错误通常在尾部）。
- 幂等工具超时可自动重试（≤2）；非幂等（workdir_edit/artifact_submit/artifact_rollback）**永不自动重试**，失败结果回注由 Agent 决策。
- 全部调用（含参数摘要/结果摘要/审批决定）以事件落会话 log（kind=tool_call/tool_result/approval_*），界面可展开审计。

## 6. 写工作目录的三条受控通道（防呆总纲）

| 通道 | 工具/服务 | 特征 | 留痕 |
| --- | --- | --- | --- |
| ① 受控编辑（**主通道**） | `workdir_edit` | 单文件声明式编辑，diff 审计 + **署名/归属校验**（他人产出物拒改，ERR_FORBIDDEN）；**任务级**聚合成 code artifact（无任务按回合兜底，D14-⑧） | tool 事件 + manifest + versionDir 补丁 + file-owners |
| ② 产出物登记 | `artifact_submit` | 项目目录里已写好的文件 → 版本快照 + manifest + 署名（**不移动文件**、不审批） | manifest + file-owners |
| ③ 命令副作用 | `cmd_run` | 命令 cwd 在 workdir 内（npm install 等运行副产物），风险分级+审批 | tool 事件审计（**已知边界：不按 owner 限制**） |

工具层**不存在**"自由写 workdir 文件"的通道；越界调用由 executor 拒绝（代码 FS_BOUNDARY）。
2026-09-14 起**无私有工作区**：角色所有产出都经 ① 直接写进项目工作目录；目录内容全员可读，写入按 `file-owners` 归属校验。

## 7. 扩展点

- `registerTool()`：新增工具（名称/描述/schema/scope/risk/审批规则/幂等/输出策略）。
- 能力组与角色默认矩阵：角色模板 yaml 中 enable/disable + 项目实例覆盖。
- 输出渲染：UI blocks 渲染器按工具名注册（会话窗口展示工具卡）。
