# Agent 工具设计 · Agent Haness

> 类别：design · 状态：草稿(待评审) · 决策依据：D11/D12/D13、prd FR-13、US-3/12
> 关联：[sandbox.md](sandbox.md)（执行安全）、[agent-runtime.md](agent-runtime.md)（loop/工具概要）、[data-storage.md](data-storage.md)（事件日志）、[meetings.md](meetings.md)（会议内可用性）

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
  "description": "在项目工作目录内执行命令（结构化参数，非自由 shell）",
  "category": "exec",
  "paramsSchema": { /* JSON Schema */ },
  "scope": "workdir",                        // workspace | workdir | readonly-global | platform
  "risk": "low",                             // none | low | high（叠加审批规则后生效）
  "network": "allowed",                      // none | allowed | outbound_high（见 sandbox.md §6）
  "needsApproval": "(rule)",                 // 规则函数/引用名，缺省取 risk
  "idempotent": false,                       // 可否安全自动重试
  "timeoutMs": 60000,
  "availableIn": ["user", "meeting"],        // 会话类型可用性（meeting 内默认禁产出/执行类）
  "allowedRoots": ["workdir", "ro"],         // 工具级可用根收窄（B4/D14-⑩，L0 是底线）：fs_*=[workdir,ro://]（不含私有区）；ws_read=[ws-self]；见 sandbox.md §3.2
  "output": { "maxChars": 12000, "strategy": "truncate-tail|summarize|raw" }
}
```

- **统一策略引擎（D18-⑥）**：`needsApproval` 与 sandbox L2 命令风险表、project.json 策略、信任开关（D17-④）同属 **PolicyEngine** 的数据源；判定输入 (actor, sessionType, tool/command, params, projectPolicy, trust) → allow/approval/deny + ruleId，优先级 **deny > approval > allow**（实现口径见 sandbox.md §5.1）。
- 命名规范：`fs_*`（文件）/`ws_*`（私有工作区）/`cmd_*`（命令）/`memory_*`（记忆）/`session_*`（会话检索）/`artifact_*`（产出物）/`meeting_*`（会议）/`approval_*`（审批）/`task_*`（任务，D15 默认关闭）。
> 说明：早期文档中的工具简写（read_file 等）已于 2026-09-08 全库同步为本规范命名（见 docs/changes 修改记录）。

## 3. 工具分类与内置清单（MVP）

| 工具 | 作用 | scope/risk/network | 幂等 | 会话可用 |
| --- | --- | --- | --- | --- |
| `fs_read_file` | 读文本文件（workdir+ro://，可 range；**不含私有区**） | readonly-global / none | ✅ | user+meeting |
| `fs_list_dir` | 列目录（workdir+ro://） | readonly-global / none | ✅ | user+meeting |
| `fs_search` | 目录内关键词搜索（workdir+ro://） | readonly-global / none | ✅ | user+meeting |
| `ws_write` | 写私有工作区文件（新建/覆盖/追加/删除） | workspace / none | 分动作 | user only |
| `ws_read` | 读自己私有区 | workspace / none | ✅ | user+meeting（D14-⑩：会议内可引用本人笔记） |
| `workdir_edit` | 工作目录受控编辑（单文件、留 diff 审计） | workdir / low | ❌ | user only |
| `cmd_run` | 在 workdir 内执行命令（结构化 argv，沙箱见 sandbox.md） | workdir / 按命令 / allowed | 视命令 | user only |
| `artifact_submit` | 提交产出物（ws 定稿 → workdir，免审批直落） | workdir / low | ❌ | user only |
| `artifact_rollback` | 回退产出物版本（服务接口保留；2026-09-09 起无 UI 入口） | workdir / high | ❌ | user only |
| `memory_search` | 检索记忆（角色+全局，按权限） | readonly-global / none | ✅ | user+meeting |
| `memory_append` | 追加长期记忆条目（scope=own 默认） | workspace(记忆) / none | ✅ | user+meeting(仅 own) |
| `session_search` | 关键词检索本项目会话日志（受 Agent 可检索集约束，D18-②） | readonly-global / none | ✅ | user+meeting |
| `approval_query` | 查看自己触发的审批状态 | platform / none | ✅ | user only |
| `meeting_start` | 发起会议（议题/成员） | platform / none | ✅ | user only |
| `meeting_advance` | 主持人推进议程/点名/追问 | platform / none | 分动作 | **meeting（仅主持人，H4 定稿）** |
| `meeting_close` | 主持人总结并结束 | platform / none | ✅ | **meeting（仅主持人，H4 定稿）** |
| `meeting_ask_user` | 请求用户拍板（question/options；会议转 blocked_waiting_user） | platform / none | — | **meeting（仅主持人，D18-①）** |
| `task_view`/`task_list` | 查看任务（本人/项目） | platform / none | ✅ | user+meeting（**D15 默认关闭**） |
| `task_assign` | 创建/指派任务（甲模式，PM） | platform / none | ✅ | user only（**D15 默认关闭**） |
| `task_update` | 更新任务状态/汇报（甲模式） | platform / none | 分动作 | user only（**D15 默认关闭**） |

说明：
- `approval_request` 不列为模型工具：审批由执行器在工具命中 high/策略时自动产生（见 sandbox.md §5），Agent 无需也不能"替用户批准"。
- **会议内（D14-⑩）**：产出与执行类一律不可用（ws_write/workdir_edit/cmd_run/artifact_*/approval_query/meeting_start）；可读：fs 读 workdir+ro://、ws_read 本人私有区、session_search、memory_search、memory_append(own)。
- **可用根（B4 定稿）**：`fs_*` 的 allowedRoots=[workdir, ro://]（**不含私有区**，读本人私有区一律走 ws_read）；`ws_read`/`ws_write` allowedRoots=[ws-self]。loop runner 的工具可用性校验 = 角色白名单 × 会话类型 × allowedRoots × 主持人身份（H4），与 sandbox §3.2 的工具级可用根一致。
- **主持人例外（H4 定稿 + D18-①）**：`meeting_advance/meeting_close/meeting_ask_user` 的 availableIn 语义 = `session.type=="meeting"` **且调用者是主持人**；loop runner 的可用性校验 = 白名单 × 会话类型 × 身份（主持人），不能只按会话类型过滤；`meeting_ask_user` 另受"同一时刻至多 1 个 pending 决策点"约束（meetings.md §5）。
- **任务工具（D15）**：`task_*` 四工具已注册但**默认不出现在任何角色矩阵**（乙模式：任务由用户 UI 创建/流转）；config `task.assignByAgent: true` 开启甲模式后按模板授权（PM 可 assign、受派者可 update），用于 A/B 对比。
- 用户直接操作（右栏回退按钮、任务状态、停用实例等）不经工具注册表。

## 4. 角色模板 ↔ 工具默认矩阵（内置模板，可覆盖）

能力按"组"配置（enable/disable），实例可在项目内调整（tools 字段覆盖的是**创建实例时的模板快照**，D16-⑤）。

| 能力组 | pm | product | architect | ux | ui | dev | qa | ops |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| 调研读取（fs_read/fs_list/fs_search/session_search） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 记忆（memory_search/memory_append-own） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 私有工作区读写（ws_*） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 工作目录受控编辑（workdir_edit） | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅¹ | ✅ |
| 命令执行（cmd_run，按 sandbox 风险审批） | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅¹ | ✅ |
| 产出物提交（artifact_submit） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 回退请求（artifact_rollback，审批） | ✅(自己的) | 同上 | 同上 | 同上 | 同上 | ✅ | ✅ | ✅ |
| 任务（task_*） | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 会议（meeting_start/advance/close/ask_user） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 全局记忆写入（memory_append scope=global） | ✅² | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

¹ qa 执行测试命令与写自动化测试文件；如需改业务代码由 dev 或授权后做。
² 仅 pm 可登记任务/进度/里程碑类全局条目；决策/会议结论类全局写入由引擎自动完成（memory.md §4），不通过工具。

设计理由：
- 命令/编辑能力默认只给"需要真机验证"的角色（dev/qa/ops），大幅降低其余角色误操作面；
- 全员都可提交自己的产出物（文档/设计稿/测试报告/部署脚本都在各自职责内）；
- 角色"默认零执行权限，按需授权"是可扩展方向：非开发角色遇到需要跑命令的任务，应把需求交给 dev/ops 或请用户在实例配置中临时启用（决策写记忆）。
- **任务行（D15）**：MVP（乙模式）全部关闭——任务由用户经 UI 创建/流转，Agent 经上下文注入获知自己的任务；开启 `task.assignByAgent` 进入甲模式后，由模板授权（如 pm 可 assign、受派者可 update），与乙模式并存用于效果对比。

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
| ① 受控编辑 | `workdir_edit` | 单文件声明式编辑，diff 审计；**任务级**聚合成 code artifact（无任务按回合兜底，D14-⑧） | tool 事件 + manifest + versionDir 补丁 |
| ② 静态产物提交 | `artifact_submit` | 私有区定稿文件 → 校验 → 写入（doc 默认审批） | approval + manifest |
| ③ 命令副作用 | `cmd_run` | 命令 cwd 在 workdir 内（npm install 等运行副产物），风险分级+审批 | tool 事件审计 |

工具层**不存在**"自由写 workdir 文件"的通道；越界调用由 executor 拒绝（代码 FS_BOUNDARY）。

## 7. 扩展点

- `registerTool()`：新增工具（名称/描述/schema/scope/risk/审批规则/幂等/输出策略）。
- 能力组与角色默认矩阵：角色模板 yaml 中 enable/disable + 项目实例覆盖。
- 输出渲染：UI blocks 渲染器按工具名注册（会话窗口展示工具卡）。
