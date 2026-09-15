# 测试计划 · Agent Haness

> 类别：testing · 状态：草稿(待评审) · 关联：[开发方案目录](../plan/)（里程碑与验收）、[prd.md](../requirements/prd.md)（验收）、[model-config.md](../design/model-config.md)（规则 27~31 的设计依据）

## 1. 测试分层与工具

Vitest 统一运行（单元 + 集成）；Mock 模型保证可重复；E2E 人工验收脚本为主（Playwright P1）。

| 层 | 对象 | 示例 |
| --- | --- | --- |
| 单元（domain，无 IO） | 状态机/规则/解析/schema 校验 | Agent 单工状态流转、路径边界判定、命令危险清单、审批策略函数、会话事件 kind 校验 |
| 单元（shared） | 错误码、配置加载、id/时间工具 | `.env` → 配置解析（`__` 分层键、JSON 数组、非法值回退默认）与缺省覆盖 |
| 集成（infra） | file-store、索引、model-gateway(mock) | 原子写/半截恢复、JSONL 逐行容错、倒排索引建/增量/查、流式 chunk 聚合 |
| 集成（application） | 会话/审批/提交/记忆/检索服务 | 消息先盘后推、提交校验与回退、摘要触发、restart 恢复 |
| E2E 验收 | 验收脚本（prd §9 主路径） | 本机走查：建项目→对话→提交→任务流转→重启恢复 |

## 2. 重点覆盖的业务规则（每项含正常/边界/非法/异常）

1. 单工不变式：同一 Agent 不同时在两个活动会话；Agent 忙时消息入队、到可中断点后处理。
2. 路径边界：越界读写一律拒绝并审计；符号链接逃逸拒绝。
3. 高危命令审批：未批准不执行；拒绝结果回注 Agent；批准/拒绝均有审计。
4. 提交制：文档提交写 workdir+manifest；版本递增与回退内容一致；delete action 需确认。
5. 会话日志：seq 单调、先盘后推、重启后 meta/log 重建状态一致。
6. 记忆：滚动摘要 ofSeq/toSeq 连续无重叠；L3 条目 active/superseded 规则；全局记忆写入权限（仅决策类由引擎写入）。
7. 中文检索：2-gram 命中与跳转（含标点/换行边界）。
8. 单实例与停用（D14-3/9）：同项目每模板至多 1 实例；停用后 dispatcher 不领活、user 会话只读归档、重新启用恢复同一会话。
9. 会话事件模型（H3/M3）：turn_start/turn_end 完整判定；轮转后 seq 跨文件单调、经 segments 跳转命中。
10. 回退内容一致性（H2）：doc 回退=versionDir 快照覆盖、code 回退=补丁反向应用，回退后 workdir 内容与快照一致。
11. 审批跨重启（M1）：pending 保持；决定落盘但不回放执行；Agent 恢复重试需重新审批。
12. 任务级代码聚合（D14-⑧/D15）：编辑归属 taskId；任务 done 后 artifact 文件清单=该任务全部变更；无任务按回合兜底；文件编辑锁命中返回 ERR_CONFLICT（M5）。
13. 原始时间线（D14-④）：会话事件按 kind 过滤完整可拉取；记忆列表 API 只读可用（M13）。
14. plan-execute 回合语义（D16-③）：回合内用户消息只入队不打断；跨重启缺 turn_end 不自动续跑（汇报中断点/续做剧本）。
15. 任务激活规则（D16-④，D17-① 修订）：每 Agent 单 in_progress（已有时新任务不可置位、无自动回退；仅完成或用户终止释放）；todo 不入上下文、口头指派改动按回合兜底。
16. 模板快照与 doc 审批预览（D16-⑤/⑥）：实例创建后修改/删除模板不影响既有实例（仅 UI 标「模板已移除」）；doc 提交审批卡含只读预览、审批记录带 previewRef。
17. 任务不抢占与终止（D17-①）：已有 in_progress 时新任务置位被拦（可先置 todo）；终止确认：存在未结算改动先结算为 code artifact 快照再置 `terminated`（可回退）；执行中终止到可中断点生效并回注 Agent（Mock 剧本验证后续步骤不再执行）。
18. doc 审批降噪与信任（D17-④）：托盘批量同意/拒绝生效；信任开关默认仅 doc/test（config/deploy 仍逐条审批）；撤销后恢复逐条。
19. 未完成回合恢复（D17-⑤）：缺 turn_end 的会话重开/重连后标「未完成」点并展示横幅三选（汇报中断点/继续执行/忽略），三选行为与 plan 事件一致；文本半截消息补全按钮并存。
20. 可停止与进行中细条（D17-⑥）：流式「停止生成」停当前回合输出且队列保留；顶部「n 个 Agent 正在工作」列表项与 plan 事件一致（Mock 长任务剧本）。
21. 共享与归属（FR-06）：工作目录内文件**全员可读**（任一角色都能 fs_read 他人产出物）；非 owner 写入返回 `ERR_FORBIDDEN` 并点名 owner；无归属文件首写即认领；用户本人不受归属校验。
22. 编排图保存与校验（D19-④）：自环/重复边/跨项目节点被拒（`ERR_ORCHESTRATION_INVALID`）；`version` 不匹配返回 `ERR_CONFLICT`；保存成功广播 `orchestration.updated`。
23. 委派边约束（D19-④）：Agent 沿出边派单成功（入 `todo` + 通知受派者）；越边目标返回 `ERR_ORCHESTRATION_EDGE` **且不建任务**；用户手动派单不受边约束。
24. 领取与汇报闭环（D19-⑤）：`todo`→`claim`→`in_progress`（每 Agent 至多 1 个，超出返回 `ERR_CONFLICT`）→`done`/`blocked`/`terminated`；完成/受阻回报派发者。
25. 询问阻塞与答复续跑（D19-⑦）：`ask_user` → Agent `waiting` + 右栏待答项；答复后继续该回合；同一 Agent 第二个提问被拒（`ERR_QUESTION_PENDING`）；跨重启 question 保持 `pending`。
26. 暂停/停止（D19-⑥）：暂停后不再领新任务、当前回合到可中断点挂起，`resume` 继续处理队列；停止终止当前任务，存在未结算改动时先结算为 code artifact 快照。
27. **模型配置校验与引用保护（D20/FR-34）**：非法 `id`/`kind`/`baseUrl`/凭证被拒（`ERR_VALIDATION`）；`env` 模式变量不存在时保存即失败；删除被引用的供应商/模型返回 `ERR_CONFLICT` 且 `detail.referrers` 点名；停用被引用模型需确认，之后该 Agent 回合报 `ERR_MODEL`。
28. **凭证不外泄（D20-④）**：供应商列表/详情响应、`config-audit.jsonl`、平台日志、`kind=error` 事件与 `ERR_MODEL` 的 `detail` 中**均不出现明文密钥**（只掩码 `hasValue`/`masked`）；供应商原始错误正文截断且脱敏。
29. **Agent 配置提交与生效（D20-⑦/FR-35）**：模板保存只影响此后新建实例（既有实例快照不变）；实例覆盖下一回合生效、运行中回合到可中断点；提示词超长、loop 参数越界、`stepModelOverride` 指向未启用模型均被拒；每次保存各写一条历史快照与 `config-audit` 记录（审计不含提示词全文）。
30. **模型调用不静默换模型（D20-⑥）**：解析失败（模型被删/停用/供应商禁用/凭证缺失）时回合报 `ERR_MODEL` 并落 `error` 事件，**不得**回退到 `defaultModelId` 或其它模型。
31. **协议适配器归一化（D20-②）**：五种 kind（`openai-compatible`/`anthropic`/`gemini`/`ollama`/`mock`）的流式增量统一归一为 `ModelChunk`（`text-delta`/`reasoning-delta`/`tool-call`/`usage`），含错误映射为 `ERR_MODEL`；Mock 剧本可驱动完整 E2E。

## 3. 测试数据与隔离

- 每个测试用例使用独立临时项目目录（os.tmpdir 下创建，测后清理），绝不触碰真实 workdir。
- Mock 模型：可编程响应（按输入匹配/固定剧本），用于模拟多轮工具调用与"模型失败重试"。
  - **脚本化 Mock（S9 落地）**：`tests/helpers-scripted-gateway.ts` 按"未消费的剧本步骤"返回文本与 `tool-call`（带条件的步骤优先于无条件兜底），使 prd §9 验收 1 的委派/领取/汇报/提问/高危命令**真的经过 agent loop**；`resolveDeps({ gateway })` 支持注入替身。
- 覆盖 flaky 点：流式中断、审批超时、文件并发写（单进程串行验证）。

## 4. 执行与门禁

- `npm run test`：单元+集成全绿是提交门槛。
- 每里程碑按开发方案（`docs/plan/`）的"演示/验收"列人工验收；端到端跑 prd §9 完整脚本。
- 覆盖率目标：domain 与 infra 关键模块 ≥ 80%（配置跳过 UI 层）。
  - **实现口径（2026-09-15，S9）**：本仓库**未引入覆盖率依赖**（`@vitest/coverage-v8` 需新增依赖与联网安装），改用**文件级触达门禁** `npm run coverage`（`tools/coverage-gate.mjs`）：把 `src/**/*.ts` 与测试文件/验收脚本的 import 图对照，未被任何测试触达的文件（白名单：`bootstrap/main.ts`、纯类型/常量入口）即失败；同时输出分层统计。规则到用例的映射见 §6。

## 5. 规则 → 用例映射（S9 收口）

| 规则 | 主要用例文件 |
| --- | --- |
| 1/5/9/26 单工·会话日志·暂停 | `tests/integration/server/sessions-api.test.ts`、`tests/acceptance/prd-section9.test.ts`（脚本 3/7） |
| 2 路径边界 | `tests/unit/infra/path-resolver.test.ts`、`tests/unit/infra/s6-stores.test.ts`、验收脚本 4 |
| 3/11 审批与跨重启 | `tests/unit/domain/policy.test.ts`、`tests/integration/server/approvals-api.test.ts`、验收脚本 4 |
| 4/10/21 提交制·回退·归属 | `tests/unit/application/artifact-service.test.ts`、`tests/integration/server/work-api.test.ts`、验收脚本 1/4 |
| 6/13 记忆·时间线 | `tests/unit/application/{memory-service,summary-engine}.test.ts`、`tests/integration/server/memory-api.test.ts` |
| 7 中文检索 | `tests/unit/shared/text.test.ts`、`tests/unit/infra/keyword-index.test.ts`、`tests/integration/server/memory-api.test.ts` |
| 8/27/28/29/30/31 模型与 Agent 配置 | `tests/integration/server/{model-config-api,model-config-import,agent-templates-api}.test.ts`、`tests/unit/infra/model-adapters.test.ts`、验收脚本 2/8 |
| 12/15/17/24 任务聚合·激活·终止·汇报 | `tests/unit/application/task-question-service.test.ts`、`tests/integration/server/work-api.test.ts`、验收脚本 1/6/7 |
| 14/19/20 恢复·停止·细条 | `tests/unit/application/runtime-recovery.test.ts`、`tests/integration/server/runtime-api.test.ts`、验收脚本 3/7 |
| 16/18 doc 审批预览与降噪 | `tests/integration/server/approvals-api.test.ts`（`previewRef`）；托盘批量与信任开关 UI 留 P1 |
| 22/23 编排图与委派边 | `tests/unit/application/orchestration-service.test.ts`、`tests/integration/server/orchestration-api.test.ts`、验收脚本 6 |
| 25 询问阻塞与答复 | `tests/unit/application/task-question-service.test.ts`、`tests/integration/server/{work-api,runtime-api}.test.ts`、验收脚本 7 |
| prd §9 脚本 1~8 | `tests/acceptance/prd-section9.test.ts`（8 个用例与 §9 条目一一对应） |

## 6. 验收执行记录

| 日期 | 范围 | 结果 |
| --- | --- | --- |
| 2026-09-15（S9） | prd §9 脚本 1~8（`tests/acceptance/prd-section9.test.ts`） | 8/8 通过；全量 `npm run test` 44 files / 302 tests 全绿；发现并修复 2 个真实缺陷（见 `docs/changes/2026-09-15-s9-acceptance-closure.md`） |
