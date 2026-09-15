# 记忆设计 · Agent Haness

> 类别：design · 状态：草稿(待评审) · 决策依据：D6/D7（双层+全文、关键词检索、向量留扩展点）、prd FR-11、US-7/8
> 关联：[data-storage.md](data-storage.md)（落盘）、[sessions.md](sessions.md)、[agent-runtime.md](agent-runtime.md)（上下文组装）

## 1. 三层记忆模型

| 层 | 载体 | 写入者 | 用途 | 生命周期 |
| --- | --- | --- | --- | --- |
| L1 会话全量日志 | `<sessionId>.log.jsonl`（append-only） | 运行时（每个事件） | 上下文构建、恢复、检索、审计、回放 | 随项目保存 |
| L2 摘要 | 会话内 `summary` 事件 | 摘要引擎 | 快速恢复上下文 | 滚动更新 |
| L3 长期条目 | `memories/global.jsonl`（项目共享）与 `memories/<instanceId>.jsonl`（角色个人） | Agent 显式写入 + 引擎自动提取 | 跨会话稳定知识 | active/superseded |

**可见性规则（重要）**：
- 全局记忆：所有 Agent 可读；写入受限（见 §4）。
- 角色记忆：仅该 Agent 可读写；其他 Agent 不可见（除非把内容提交为产出物）。
- 会话日志：用户-角色会话日志仅会话双方可读；用户对所有会话可见。
- **检索同等可见（D18-②）**：`session_search`/`memory_search` 与直接读共用同一可见性判定（domain/rules 纯函数）；Agent 可检索集 = 本人 user 会话 ∪ 项目全局记忆 ∪ 本人角色记忆；**用户侧检索不受限**。
- 用户（老板）通过 UI 可浏览/检索全部（他有平台管理权），含 L1 原始事件时间线查看（D14-④）。

## 2. L1 会话全量日志（真相源）

- 结构见 data-storage.md §4.2（seq/turn/kind 事件模型，含 `turn_start/turn_end` 回合边界、`plan` 事件与跨轮转 segments）。
- 规则：**先落盘、后推送**（thought/工具等事件至少一次写入）；**流式文本例外**（D14-⑦）：增量先推 UI，完整消息在流结束落盘为一条 `message` 事件——半截内容不入 log，崩溃以"未完成"标记 + 补全/重说兜底。损坏容错逐行读。
- 用途举例：
  - 上下文窗口：摘要 + 最近 N 条原文（默认值见 agent-runtime §4 contextLimits）；
  - 中断恢复：以 `turn_end` 缺失判定未完成回合，重放会话尾部（§6）；
  - 检索：关键词命中 → 经 seq+segments 定位注入片段（data-storage §10）；
  - 审计：事件流即素材；
  - **UI 原始事件时间线**（D14-④）：按会话浏览全部 kind 事件（thought/tool 默认折叠可展开），与检索/摘要视图并存。

## 3. L2 摘要

### 3.1 滚动摘要（user 会话/长会话）

- 触发：每累计 ~40 条事件 或 关键事件（artifact 提交、approval、Agent 主动 `memory.checkpoint`）。
- 摘要引擎基于窗口内文本（模型生成，可用角色相同/更省模型）产出**结构化摘要**，写为 log 的 `summary` 事件：
  `{ seq, kind: "summary", summaryId, ofSeq: start, toSeq: end, digest: {主题, 目标, 已定结论, 关键信息, 待办, 相关产出物, 未决问题} }`
  字段与 data-storage §4.1 meta `summaryRefs[]` 完全一致（M10 定稿）。
- 恢复/上下文构建时：摘要段替代原始窗口（保留最近 M 条原文），显著省 token 且不丢要点。

## 4. L3 长期条目

条目 schema（data-storage.md §5）：`type ∈ fact|decision|preference|commitment|requirement|progress|artifact_index`。

- **角色个人**：该 Agent 可随时 `memory_append`（如"用户偏好中文注释/方案 A 被否"、项目相关个人承诺）。
- **全局**：默认**追加受限**：
  - 决策条目：由用户显式确认后登记（引擎自动）；
  - 需求/里程碑：PM 协调结论或用户确认后写入；
  - Agent 想写入全局须先提交为产出物（防止记忆污染）。全局条目标注 source（会话/产出物），可追溯。
- **回收（compaction）**：被 superseded 的条目保留原行 + `state=superseded, supersededBy=…`，不物理删除；条目超量时按类型分层保留最近 N 条 active。
- 用户可在 UI 查看/钉住/删除（P1，FR-19）；MVP 至少可看。

**Agent 上下文组装时如何取 L3**：按「相关度排序 + 类型分组 + 数量上限」取（global 上限与 role 上限可配置）；检索命中历史片段时按 tag 注入。相关度先以时间衰减+关键词命中实现，向量排序留扩展。

## 5. 检索（关键词，MVP）

- 范围/实现/索引见 data-storage.md §10（token→文件行号倒排，2-gram 中文回退）。
- UI：全局搜索框（项目级默认）→ 结果按会话/记忆分组，命中行带上下文与跳转（打开对应会话滚动到该 seq）。
- 检索结果回注 Agent：当 Agent 调用 `session_search`/`memory_search` 时，返回片段块（含会话 id/seq/token 摘要）而非裸行堆砌。

## 6. 中断恢复流程（US-7，进程/浏览器双维度）

| 中断 | 恢复 |
| --- | --- |
| 浏览器关闭/刷新 | 无服务端影响；重连后按会话窗口重新拉取。流式进行中被中断：半截文本不入 log（D14-⑦），UI 标记"（未完成）"，用户可"补全/重说"（服务进程仍在时临时文本可从内存续补；进程已重启则半截文本丢失，"补全"=服务端以已落盘上下文让模型续写，锚点用 turnId，B5）。 |
| 服务进程退出 | 重启扫描 session meta：user 会话 suspended 由 dispatcher **occupancy 重建**（D18-④，meta 仅缓存）；进行中回合以缺 `turn_end` 判定未完成，Agent 下次触发时先读摘要+尾部窗口，主动汇报中断点（**不自动续跑**，D16-③）。 |
| 审批等待跨重启（M1） | approval 保持 `pending`，用户决定落盘但**不回放执行**；Agent 恢复时读取决定自行决定重试（重试需重新审批）。见 agent-runtime §7。 |
| Agent 回合中途重启 | 以 `turn_start/turn_end` 判定完整性（事件模型已含，H3）；恢复后 Agent 说明已做到哪、续做或重做（给用户选择）。 |
| plan-execute 断点 | 计划与进度在 `plan` 事件中持久化（data-storage §4.2）；重启后**不自动续跑**（D16-③）：缺 turn_end=未完成，用户下一条消息触发 Agent 读最近 plan 事件 + 摘要尾部，汇报中断点或选择续做。 |

恢复工具：`resume_context(scope)` = 摘要 + 最近窗口 + 相关 L3 条目 + 未完成任务，用于"回到现场"。

## 7. 记忆写路径与事件（统一）

所有写入最终都落盘为两类文件之一：会话 log（事件）或 memories/*.jsonl（条目）。
- 会话 log 写入 = 事件总线统一处理（`session.message_appended` 等）。
- L3 写入 = 显式工具调用/引擎后台任务，原子追加 + 同步更新相关会话摘要引用。
- 防止双写：同一进程串行化记忆写（file-store 写锁）。

## 8. 扩展点（向量检索）

预留 `SearchProvider` 接口与 `semantic/` 目录：L1 事件与 L3 条目的"可向量化文本"提取器 + embedding 服务注入点（FR-22，P2）。MVP 全部关键词检索即可，不引依赖。

## 9. 实现口径（2026-09-15，S5）

- **文件**：`memories/global.jsonl` 与 `memories/<instanceId>.jsonl` **append-only**；`supersede` 不原地改，而是追加一条"同 id、`state=superseded, supersededBy=…`"的行，读取时同 id 取最后一条（与 `approvals.jsonl` 同构，崩溃不产生半更新）。
- **写入权限落地**：`MemoryService.appendOwn`（角色记忆，工具 `memory_append` 走这里）/ `recordGlobal`（**白名单** `decision|requirement|progress`，其余 → `ERR_FORBIDDEN`）。
- **摘要触发**：累计 `DEFAULT_SUMMARY_TRIGGER_MESSAGES = 40` 条**未摘要** `message` 事件（`src/shared/loop.ts`）；不足阈值**不调模型**（返回 `below-threshold`）。摘要由该实例的有效模型产出 JSON `{topic,goals,decisions,facts,todos,questions}`，解析失败退化为 `digest.text`。
- **摘要事件字段**：`{summaryId, ofSeq, toSeq, digest, model, coveredMessages}`；`ofSeq` = 窗口首条消息 seq、`toSeq` = 末条消息 seq，**下一条摘要的 `ofSeq` 必大于上一条 `toSeq`**（可重放派生视图；重复调用只处理新窗口）。
- **引擎自动提取（L3）**：每次摘要成功同时向该角色记忆追加一条 `progress` 条目（`source={sessionId, toSeq}`）。决策/需求类的全局条目仍走用户确认路径（S6），不做自动识别以免污染。
- **检索实现**：`search-index/index.json` 为单文件倒排（token → `s:<sessionId>:<seq>` / `m:<entryId>`），查询前按 `lastSeq`/条目 id **增量 sync**，损坏或缺失即视为空索引重建；中文用 **2-gram 主索引 + 汉字单字回退索引**（单字查询弱命中，长查询不放松以免噪声）。
- **可见性**：`domain/rules/visibility.ts` 纯函数同时供工具（`session_search`/`memory_search`）与 `GET /search` 使用；用户侧不受限，Agent 侧仅本人会话 ∪ 全局记忆 ∪ 本人角色记忆。
