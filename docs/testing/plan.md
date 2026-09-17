# 测试计划 · Agent Haness

> 类别：testing · 状态：草稿(待评审) · 关联：[开发方案目录](../plan/)（里程碑与验收）、[prd.md](../requirements/prd.md)（验收）、[model-config.md](../design/model-config.md)（规则 27~31 的设计依据）

## 1. 测试分层与工具

Vitest 统一运行（单元 + 集成）；模型替身保证可重复；E2E 人工验收脚本为主（Playwright P1）。

| 层 | 对象 | 示例 |
| --- | --- | --- |
| 单元（domain，无 IO） | 状态机/规则/解析/schema 校验 | Agent 单工状态流转、路径边界判定、命令危险清单、审批策略函数、会话事件 kind 校验 |
| 单元（shared） | 错误码、配置加载、id/时间工具 | `.env` → 配置解析（`__` 分层键、JSON 数组、非法值回退默认）与缺省覆盖 |
| 集成（infra） | file-store、索引、model-gateway(替身网关) | 原子写/半截恢复、JSONL 逐行容错、倒排索引建/增量/查、流式 chunk 聚合 |
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
13. 原始时间线（D14-④）：会话事件按 kind 过滤完整可拉取（`GET .../sessions/:sid/log?kind=`，接口能力不变；**S22 起会话流 UI 不再提供筛选与折叠包装**，展示范围为对话/思考/工具调用/结果/错误）；记忆列表 API 只读可用（M13）。
14. plan-execute 回合语义（D16-③）：回合内用户消息只入队不打断；跨重启缺 turn_end 不自动续跑（汇报中断点/续做剧本）。
15. 任务激活规则（D16-④，D17-① 修订）：每 Agent 单 in_progress（已有时新任务不可置位、无自动回退；仅完成或用户终止释放）；todo 不入上下文、口头指派改动按回合兜底。
16. 模板快照与 doc 审批预览（D16-⑤/⑥）：实例创建后修改/删除模板不影响既有实例（仅 UI 标「模板已移除」）；doc 提交审批卡含只读预览、审批记录带 previewRef。
17. 任务不抢占与终止（D17-①）：已有 in_progress 时新任务置位被拦（可先置 todo）；终止确认：存在未结算改动先结算为 code artifact 快照再置 `terminated`（可回退）；执行中终止到可中断点生效并回注 Agent（脚本化网关剧本验证后续步骤不再执行）。
18. doc 审批降噪与信任（D17-④）：托盘批量同意/拒绝生效；信任开关默认仅 doc/test（config/deploy 仍逐条审批）；撤销后恢复逐条。
19. **中断收尾由 Agent 自查（S21/D27 重写；原 D17-⑤ 三选已删）**：平台**不判定、不提示、不注入恢复消息**（`GET/POST .../recovery` 返回 404）；Agent 在被唤醒时可用 `session_recent` 读到本会话最近事件（**含 `turn_start`/`turn_end` 边界**，尾窗语义、只读自己的会话），据此自行判断上一回合是否收尾，并用 `ask_user` 发起询问（询问进右栏列表、Agent 转 `waiting`）。用例覆盖：工具事实渲染 + 尾窗 + 参数无 `sessionId` + 恢复接口 404。
20. 可停止与进行中细条（D17-⑥；**位置与空态由 D25-③ 修订**）：流式「停止生成」停当前回合输出且队列保留；**「拓扑」页编排图顶部**的「n 个 Agent 正在工作」列表项与 plan 事件一致（脚本化网关长任务剧本）；**无 Agent 在工作时细条不渲染**（原"当前没有 Agent 在工作"空态取消）。
21. 共享与归属（FR-06）：工作目录内文件**全员可读**（任一角色都能 fs_read 他人产出物）；非 owner 写入返回 `ERR_FORBIDDEN` 并点名 owner；无归属文件首写即认领；用户本人不受归属校验。
22. 编排图保存与校验（D19-④）：自环/重复边/跨项目节点被拒（`ERR_ORCHESTRATION_INVALID`）；`version` 不匹配返回 `ERR_CONFLICT`；保存成功广播 `orchestration.updated`。
23. 委派边约束（D19-④）：Agent 沿出边派单成功（入 `todo` + 通知受派者）；越边目标返回 `ERR_ORCHESTRATION_EDGE` **且不建任务**；用户手动派单不受边约束。
24. 领取与汇报闭环（D19-⑤）：`todo`→`claim`→`in_progress`（每 Agent 至多 1 个，超出返回 `ERR_CONFLICT`）→`done`/`blocked`/`terminated`；完成/受阻回报派发者。
25. 询问阻塞与答复续跑（D19-⑦）：`ask_user` → Agent `waiting` + 右栏待答项；答复后继续该回合；同一 Agent 第二个提问被拒（`ERR_QUESTION_PENDING`）；跨重启 question 保持 `pending`。
26. 暂停/停止（D19-⑥；**S37/D40 补实现口径**）：暂停后不再领新任务，**在途回合当场**在可中断点收尾（中断不排队等 `drain` 锁）且**游标不推进** → 消息留在队列，`resume` 补处理；中断后不再自动续跑队列；**停止生成**（`stop{turn}`）＝本条作废、剩余队列不自动续跑，无在途回合时 `aborted=false` 并如实提示；**停止任务**（`stop{task}`）先中断再终止，存在未结算改动时先结算为 code artifact 快照。
27. **模型配置校验与引用保护（D20/FR-34）**：非法 `id`/`kind`/`baseUrl`/凭证被拒（`ERR_VALIDATION`）；`env` 模式变量不存在时保存即失败；删除被引用的供应商/模型返回 `ERR_CONFLICT` 且 `detail.referrers` 点名；停用被引用模型需确认，之后该 Agent 回合报 `ERR_MODEL`。
28. **凭证不外泄（D20-④）**：供应商列表/详情响应、`config-audit.jsonl`、平台日志、`kind=error` 事件与 `ERR_MODEL` 的 `detail` 中**均不出现明文密钥**（只掩码 `hasValue`/`masked`）；供应商原始错误正文截断且脱敏。
29. **Agent 配置提交与生效（D20-⑦/FR-35）**：模板保存只影响此后新建实例（既有实例快照不变）；实例覆盖下一回合生效、运行中回合到可中断点；提示词超长、loop 参数越界、`stepModelOverride` 指向未启用模型均被拒；每次保存各写一条历史快照与 `config-audit` 记录（审计不含提示词全文）。
30. **模型调用不静默换模型（D20-⑥）**：解析失败（模型被删/停用/供应商禁用/凭证缺失）时回合报 `ERR_MODEL` 并落 `error` 事件，**不得**回退到其它模型；S14 起生效链只有两级（`实例覆盖 → 模板快照`），两级全空同样报 `ERR_MODEL` 且不做任何隐式兜底。
31. **协议适配器归一化（D20-②）**：四种 kind（`openai-compatible`/`anthropic`/`gemini`/`ollama`）的流式增量统一归一为 `ModelChunk`（`text-delta`/`reasoning-delta`/`tool-call`/`usage`），含错误映射为 `ERR_MODEL`；替身剧本（脚本化网关）可驱动完整 E2E。
32. **模板删除/停用与一键配置模型（D22/FR-35）**：内置模板删除 → `ERR_FORBIDDEN`（只能停用）、用户模板删除需 `confirm=true` 且被项目实例引用 → `ERR_CONFLICT` + `detail.referrers`（点名项目/实例）；内置模板的停用与默认模型写 `data/agent-templates-state.json` 覆盖且**跨重启保持**（仓库 yaml 不被改写）、内置的提示词/loop 仍只读；`POST /api/agent-templates/bulk-model` 批量写默认模型（内置走覆盖、用户写 yaml）返回 `{updated, skipped}`，非法/停用模型或空选择 → `ERR_VALIDATION`；`GET /api/model-config/overview` 的 `unconfiguredAgents` 口径 = 启用实例且两级生效链（`实例覆盖 → 模板快照`）为空（**S14 起不含平台默认**，改模板默认只影响此后新建实例，既有实例需实例覆盖才会减少计数）。
33. **「默认路由」已删除（S14/D24）**：`GET/PUT /api/model-routing` 返回 404；`overview` 响应不含 `routing` 字段；`/api/config` 的 `models` 不含 `defaultModelId`；遗留 `data/model-config.json` 里的 `routing` 键在启动时被抹掉并写审计（`action=migrate`、`diff.removed=["routing"]`）。

## 3. 测试数据与隔离

- 每个测试用例使用独立临时项目目录（os.tmpdir 下创建，测后清理），绝不触碰真实 workdir。
- 模型替身位于 `tests/`：`helpers-in-memory-adapter.ts`（适配器归一化基准）、`helpers-scripted-gateway.ts`（脚本化网关，让委派/领取/提问/审批真的经过 agent loop）。
  - 脚本化网关（S9 落地）按"未消费的剧本步骤"返回文本与 `tool-call`（带条件的步骤优先于无条件兜底），`resolveDeps({ gateway })` 支持注入替身；`helpers-model.ts` 的 `configureTestModel` 为用例显式登记供应商与模型条目（S14 起不再有平台默认），`applyModelToAllTemplates` 在建项目前把模型写进模板默认（实例快照才带模型）。
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
| 32 模板删除/停用与一键配置模型 | `tests/integration/server/s11-template-delete-bulk.test.ts`、`tests/integration/server/agent-templates-api.test.ts`（内置停用跨重启） |
| 33 「默认路由」已删除 | `tests/integration/server/model-config-api.test.ts`（404 + overview 无 routing）、`tests/integration/server/model-config-s10-bootstrap.test.ts`（legacy routing 清理 + 审计）、`tests/unit/infra/model-config-store.test.ts` |
| 12/15/17/24 任务聚合·激活·终止·汇报 | `tests/unit/application/task-question-service.test.ts`、`tests/integration/server/work-api.test.ts`、验收脚本 1/6/7 |
| 14/19/20 恢复·停止·细条 | `tests/integration/server/runtime-api.test.ts`（规则 14/20 的停止与细条；S21 起规则 19 改为"恢复接口 404"断言）、`tests/integration/server/memory-api.test.ts`（`session_recent` 事实视图）、验收脚本 3/7 |
| 16/18 doc 审批预览与降噪 | `tests/integration/server/approvals-api.test.ts`（`previewRef`）；托盘批量与信任开关 UI 留 P1 |
| 22/23 编排图与委派边 | `tests/unit/application/orchestration-service.test.ts`、`tests/integration/server/orchestration-api.test.ts`、验收脚本 6（S17 起画布分浏览/编辑模式，保存契约与校验不变，用例无需改动） |
| 25 询问阻塞与答复 | `tests/unit/application/task-question-service.test.ts`、`tests/integration/server/{work-api,runtime-api}.test.ts`、验收脚本 7 |
| prd §9 脚本 1~8 | `tests/acceptance/prd-section9.test.ts`（8 个用例与 §9 条目一一对应） |

## 6. 验收执行记录

| 日期 | 范围 | 结果 |
| --- | --- | --- |
| 2026-09-15（S9） | prd §9 脚本 1~8（`tests/acceptance/prd-section9.test.ts`） | 8/8 通过；全量 `npm run test` 44 files / 302 tests 全绿；发现并修复 2 个真实缺陷（见 `docs/changes/2026-09-15-s9-acceptance-closure.md`） |
| 2026-09-16（S10） | prd §9 脚本 1~8 按新口径（移除 mock / Agent 默认不配置模型，prd D21） | 8/8 通过（脚本 2 重写为"未配置模型 → `ERR_MODEL` + 配置引导"）；全量 `npm run test` **45 files / 306 tests 全绿**；`coverage` 触达门禁 140/140；活体验证真实 `data/model-config.json` 迁移（审计 `removedProviders:["mock"]`）且未配置模型启动回合报 `ERR_MODEL`；发现并修复 2 个问题（`MODELS__DEFAULT` 未生效、测试未合成 env 配置），见 `docs/changes/2026-09-16-s10-remove-mock.md` |
| 2026-09-16（S11） | 模板删除/停用与一键配置模型（prd D22，规则 32） | `npm run test` **46 files / 311 tests 全绿**（新增 `tests/integration/server/s11-template-delete-bulk.test.ts` 5 例 + 重写内置停用用例）；`coverage` 触达门禁 141/141；发现并修复 1 个真实缺陷（`team-service` 的 `effectiveModelLabel/effectiveModelAvailable` 未走完整回退链，导致靠全局默认生效的实例被误标"不可用"），见 `docs/changes/2026-09-16-s11-template-delete-bulk-model.md` |
| 2026-09-16（S12/S13） | 工具模块瘦身（S12）；`ask_user` 独立为 `interaction` 包（S13/D23） | `npm run test` **47 files / 314 tests 全绿**；构建产物冒烟（不再含 `agent loop 策略`、含 `工具包详情`）；活体确认 8 个工具包且 `interaction` 已注册 |
| 2026-09-16（S14） | 删除「默认路由」功能（prd D24，规则 33） | `npm run test` **47 files / 314 tests 全绿**（`model-config-api` 加 404/无 routing 断言、`model-config-s10-bootstrap` 改为覆盖 S10 旧 kind + S14 routing 两类迁移、`model-config-store` 增 legacy routing notice 用例、`effective-config` 改两级、S11 计数用例改"模板默认/实例覆盖"路径）；活体验证真实 `data/model-config.json` 的 `routing` 键被抹掉且审计 `removed:["routing"]`，见 `docs/changes/2026-09-16-s14-remove-model-routing.md` |
| 2026-09-16（S15） | 项目详情页瘦身（prd D25，规则 20 位置/空态修订） | `npm run test` **47 files / 314 tests 全绿**（本轮无后端改动，防回归；首次全量运行出现 1 例未记名失败，随后连续 3 次全量重跑全绿，判断为既有偶发）；`typecheck`（src+web）/`eslint`/`npm run build` 通过；构建产物冒烟：不再含 `当前没有 Agent 在工作`、`项目信息`，仍含 `导出项目数据` 与 `个 Agent 正在工作`；见 `docs/changes/2026-09-16-s15-project-detail-slim.md` |
| 2026-09-16（S16） | 会话页瘦身（去掉「实时通道已连接」成功态提示，仅断开警告；无规则改动） | `npm run test` **47 files / 314 tests 全绿**（本轮无后端改动，防回归）；`typecheck`（src+web）/`eslint`/`npm run build` 通过；构建产物冒烟：不再含 `实时通道已连接`、`事件先落盘后推送`、`S4 起`，仍含 `实时通道未连接`；见 `docs/changes/2026-09-16-s16-session-page-slim.md` |
| 2026-09-16（S17） | 编排图交互修复 + 浏览/编辑双模式（prd D26；规则 22 契约不变） | `npm run test` 全绿（规则 22/23 与验收脚本 6 未受影响）；`typecheck`（src+web）/`eslint`/`npm run build` 通过；构建产物冒烟：含 `编辑模式`/`退出编辑`/`连线模式：点起点`/`移出图`/`放弃并退出`，不含旧的 `连到这里`；**指针/点击类交互无浏览器自动化可用，须由用户刷新后点验（R1~R5）**，根因与修复口径见 `docs/changes/2026-09-16-s17-orchestration-edit-mode.md` |
| 2026-09-16（S18） | 删除边可用性修复（14px 点击热区 + 「删除选中边」按钮；规则 22 契约不变） | `npm run test` 全绿（规则 22/23 与验收脚本 6 未受影响）；`typecheck`（src+web）/`eslint`/`npm run build` 通过；构建产物冒烟：含 `删除选中边`；**点击类交互须由用户刷新后确认**（离线 5~7px 处可选中、按钮可删、点空白取消选中），见 `docs/changes/2026-09-16-s18-edge-delete-affordance.md` |
| 2026-09-16（S19） | 会话页 Agent 列表只保留名称与状态（UI 简化；无规则改动） | `npm run test` **47 files / 314 tests 全绿**（本轮无后端改动，防回归）；`typecheck`（src+web）/`eslint`/`npm run build` 通过；构建产物冒烟：含 `工作中`/`等待中`/`已暂停`，不再含 `（暂无消息）`；见 `docs/changes/2026-09-16-s19-session-list-name-status.md` |
| 2026-09-16（S20） | 会话页聊天区放大（消息区高度自适应 + 左右栏可收起；无规则改动） | `npm run test` **47 files / 314 tests 全绿**（本轮无后端改动，防回归）；`typecheck`（src+web）/`eslint`/`npm run build` 通过；产物含 `calc(100vh - 350px)` 与 `agent-haness.session-panel-collapsed`；**布局效果须由用户刷新后确认**（聊天区变高、收起两栏变宽、状态记忆），见 `docs/changes/2026-09-16-s20-session-chat-roomier.md` |
| 2026-09-16（S21） | 未完成回合改由 Agent 自查与询问（prd D27；规则 19 重写、规则 14 的恢复入口取消） | `npm run test` **46 files / 304 tests 全绿**（删 `tests/unit/application/runtime-recovery.test.ts` 10 条；`runtime-api` 改为断言三条 `/recovery` 路径 404 并检查 `/runtime` 无 `unfinishedTurn`；`memory-api` 新增 `session_recent` 事实视图用例；`tool-packages-api` 增 `session` 包与 8 个模板 `session_recent` 断言）；`coverage` 触达 **140/140**（删除 `application/recovery/recovery-service.ts` 后总数下降属预期）；`typecheck`（src+web）/`eslint`（含 infra 未越层依赖）/`ratchet`/`vite build` 均通过；**"重启后 Agent 是否真的自查并提问"须由用户实测**（本仓库无浏览器/端到端自动化），见 `docs/changes/2026-09-16-s21-agent-driven-recovery.md` |
| 2026-09-16（S22） | 会话流去掉事件筛选与"工作日志"折叠包装（prd D28；FR-30 修订；纯前端） | `npm run test` **46 files / 304 tests 全绿**（本轮无后端改动，防回归）；`typecheck`（src+web）/`eslint`/`npm run build` 通过；产物冒烟：不再含 `工作日志 ·`/`仅看对话`/`显示全部事件`，含 `思考`/`工具调用`/`工具结果`；**展示效果须由用户刷新后确认**，见 `docs/changes/2026-09-16-s22-session-stream-inline.md` |
| 2026-09-16（S23） | 对话消息按 Markdown 渲染（prd D29；**首批前端逻辑单测**） | 新增 `tests/unit/web/markdown.test.ts` **11 条**（解析器纯函数化才可被 node 侧 vitest 引用：空文本/段落换行/标题/行内五类/协议白名单/围栏代码块/未闭合围栏/列表/引用与分隔线/HTML 当文本/段落不吞块）；全量 `npm run test` **47 files / 315 tests 全绿**；`coverage` 140/140、`ratchet` 违规 0、`typecheck`（含 tests→web 引用）/`eslint`（web 不得依赖 src）/`vite build` 通过，见 `docs/changes/2026-09-16-s23-message-markdown.md` |
| 2026-09-16（S24） | 工具调用/结果不显示的缺陷修复（事件字段契约对齐） | 现象：工具行只显示「工具调用 工具」、参数与结果不显示。根因：生产者 payload 为 `{tool,callId,input}`/`{tool,callId,ok,summary}`，消费者按 `name`/`args`/`text` 读；**且 S21 用例 fixture 凭印象手写**，实现与测试一起错。修复与验证：抽出 `web/src/lib/event-display.ts` + **7 条单测**（fixture 照抄生产者）、`session_recent` 同步对齐、集成用例 fixture 换真实形态、验收脚本新增**真实 loop 事件 → `session_recent` 渲染**钉子断言；全量 `npm run test` **48 files / 322 tests 全绿**；`coverage` 140/140、`ratchet` 0、`typecheck`/`eslint`/`vite build` 通过，见 `docs/changes/2026-09-16-s24-tool-event-fields.md` |
| 2026-09-16（S25） | 基础工具包「全员必装」强制化（prd D30；规则强化） | 新增 `tests/unit/domain/tool-packages.test.ts` **5 条**（空清单/缺包补齐且顺序固定/额外包保留去重/幂等/`missingBasePackages`）；`projects-api` 增"创建项目后逐个实例快照含 8 包"与"旧快照 `packages: []` → `GET /team` 的 `effective.packages` 仍为 8 个（读侧补齐、不改磁盘）"；`tool-packages-api` 逐个断言 8 个内置模板覆盖全部基础包；全量 `npm run test` **49 files / 328 tests 全绿**；`coverage` **141/141**（新增 domain 规则文件被用例触达）、`ratchet` 0、`typecheck`/`eslint`/`vite build` 通过，见 `docs/changes/2026-09-16-s25-packages-always-mounted.md` |
| 2026-09-16（S26） | 工具结果条目只显示工具名（prd D31；纯前端） | `tests/unit/web/event-display.test.ts` 增 `eventRow` 用例（工具结果 → `{label:'fs_read_file', body:null, showMeta:false}`；工具调用/思考/错误 → 标题+正文+序号）；`tests/unit/web/` **19 passed**；全量 `npm run test` **49 files / 329 tests 全绿**；`coverage` 141/141、`ratchet` 0、`typecheck`/`eslint`/`vite build` 通过（产物 `web/dist/assets/index-ZVM0m1fG.js`，产物不再含 `工具结果（`），见 `docs/changes/2026-09-16-s26-tool-result-name-only.md` |
| 2026-09-16（S27） | 改用成熟框架渲染 Markdown（prd D32；技术选型变更） | 新增 devDependencies `react-markdown@10.1.0` + `remark-gfm@4.0.1`（96 个包）；`web/src/components/Markdown.tsx` 改框架渲染，**删除**自研 `web/src/lib/markdown.ts` 与其 14 条用例（本仓库前端单测数 329 → 318，仅保留 `event-display` 的 8 条展示映射用例）；`typecheck`/`eslint`/`ratchet`(0)/`coverage`(141/141) 通过；产物 1,193 kB → **1,346 kB（gzip +47 kB）**；**GFM 表格渲染需用户刷新后点验**，见 `docs/changes/2026-09-16-s27-markdown-framework.md` |
| 2026-09-16（S28） | 工具调用参数默认折叠（prd D33；纯前端） | `eventRow` 增 `bodyMode: 'inline' \| 'collapsed' \| 'none'`，工具调用 → `collapsed`（无参数 → `none`）、工具结果 → `none`、思考/错误 → `inline`；`tests/unit/web/event-display.test.ts` **9 passed**；渲染用 antd `Collapse`（`ghost`、不传 `defaultActiveKey`，无新增包）；全量 `npm run test` **48 files / 319 tests 全绿**；`coverage` 141/141、`ratchet` 0、`typecheck`/`eslint`/`vite build` 通过（产物 1,346.52 kB → **1,356.70 kB / gzip 424.96 kB**，活体 200），见 `docs/changes/2026-09-16-s28-tool-call-args-collapsed.md` |
| 2026-09-16（S29） | 「提示词预览」点击无反应的缺陷修复（弹窗挂载到两个分支；纯前端） | 根因：预览弹窗 JSX 只在**项目列表**分支，按钮在**详情**分支（互斥顶层 `return`）→ 接口成功、`setPreview` 生效，但当前渲染树无消费者。修复：抽 `PromptPreviewModal` 并在两分支各挂一次；同类风险审计（同页与其它页浮层）确认仅此一处错位。全量 `npm run test` **48 files / 319 tests 全绿**；`coverage` 141/141、`ratchet` 0、`typecheck`/`eslint`/`vite build` 通过（产物 `index-CdDznYHF.js`，活体 200）；**弹窗可见性须用户点验**（本仓库无 DOM 测试，这正是该缺陷逃过自动化的原因），见 `docs/changes/2026-09-16-s29-preview-modal-branch.md` |
| 2026-09-16（S30） | 工具调用文本化（DSML）根因修复 + 兼容层（prd D34；规则 14/19 不受影响） | 根因：`strategies.ts` 三处"拿到工具结果后的追问"漏传 `tools` → 模型只能用自家文本协议写调用（DSML）→ 标记落进会话且调用未执行。修复与验证：`runToolLoop()` 让追问轮每轮带 `toolSchemas`（上限 4 轮）；`shared/dsml.ts` 提取 DSML 调用并从正文剥离（`runner.callModel` 出口并入 `toolCalls` 走同一套闸门，失败落 `state` 诊断）。新增 `tests/unit/shared/dsml.test.ts` **6 条** + `loop-strategies` S30 回归（追问 `callToolSchemaCounts=[0,1,1,1]`、追问里的工具真被执行）；全量 `npm run test` **49 files / 326 tests 全绿**；`coverage` **142/142**（新增 shared 文件被用例触达）、`ratchet` 0、`typecheck`/`eslint`/`vite build` 通过，见 `docs/changes/2026-09-16-s30-dsml-tool-calls.md` |
| 2026-09-16（S31） | 发送消息后输入框残留文字（乐观清空；纯前端） | 根因：`POST /messages` 在服务端 `await drain(...)`（**整轮跑完才响应**），前端等它返回才 `setDraft('')` → 整轮期间输入框留字、发送按钮持续 loading。修复：先清空再发请求，失败才恢复（且不覆盖等待期间的新输入）。全量 `npm run test` **49 files / 326 tests 全绿**；`coverage` 142/142、`ratchet` 0、`typecheck`/`eslint`/`vite build` 通过（产物 `index-gCALdmMk.js`，活体 200）；**输入框行为须用户点验**，见 `docs/changes/2026-09-16-s31-input-clear.md` |
| 2026-09-16（S32） | 询问答复入口归位（prd D35；纯前端） | 会话窗口输入框上方新增「待答复询问（n）」卡（只列当前会话，选项点选/文本回答）；右栏与任务页询问区降级为提示 + 「到会话里答复」跳转；后端接口不变。全量 `npm run test` **49 files / 326 tests 全绿**（验收脚本 7.2 走 HTTP，未受影响）；`coverage` 142/142、`ratchet` 0、`typecheck`/`eslint`/`vite build` 通过（产物 `index-BvYi7Mli.js`，冒烟含 `待答复询问`/`到会话里答复`，活体 200）；**卡片位置与答复流程须用户点验**，见 `docs/changes/2026-09-16-s32-question-in-session.md` |
| 2026-09-16（S33） | 询问改为逐题作答 + 卡片左右滑动（prd D36；纯前端） | 新增 `tests/unit/web/question-wizard.test.ts` **6 条**（草稿记账与覆盖、已答计数与必答校验、缺答点名、游标两端夹取、滑动阈值方向、提交负载只带已答项）；`tests/unit/web/` **15 passed**；全量 `npm run test` **50 files / 332 tests 全绿**；`coverage` 142/142、`ratchet` 0、`typecheck`/`eslint`/`vite build` 通过（产物 `index-B8zmHUtu.js`，活体 200）；**滑动手势与"一次提交唤醒一次"须用户点验**，见 `docs/changes/2026-09-16-s33-question-carousel.md` |
| 2026-09-16（S34） | 会话窗口铺满屏幕 + 自动跟随最新消息；工具报错显示报错内容（prd D37；纯前端） | `eventRow` 的 `tool_result` 失败时改为输出报错正文（成功仍只有工具名），`event-display.test.ts` 相应用例改为"成功只有名字 / 失败显示报错"；`SessionPanel` 会话卡片改纵向 flex（`calc(100vh - 270px)`、消息区 `flex:1`）+ `scrollRef`/`stickToBottom` 自动跟随。`tests/unit/web/` **15 passed**；全量 `npm run test` **50 files / 332 tests 全绿**；`coverage` 142/142、`ratchet` 0、`typecheck`/`eslint`/`vite build` 通过（产物 `index-D87m1wEH.js`，活体 200）；**高度/跟随/报错显示须用户点验**，见 `docs/changes/2026-09-16-s34-scroll-and-tool-errors.md` |
| 2026-09-16（S35） | 会话窗口新增「详细日志（trace）」视图（prd D38；纯前端） | `event-display.test.ts` 增"详细日志行"用例（message/plan/turn_start/turn_end/state/工具成功与失败/时间戳缺失兜底）；`tests/unit/web/` **16 passed**；全量 `npm run test` **50 files / 333 tests 全绿**；`coverage` 142/142、`ratchet` 0、`typecheck`/`eslint`/`vite build` 通过（产物 `index-D9Oh5z_A.js`，冒烟含 `详细日志`，活体 200）；**切换与展开 payload 须用户点验**，见 `docs/changes/2026-09-16-s35-trace-view.md` |
| 2026-09-16（S36） | 任务汇报闭环：派发人收到回报并继续执行（prd D39；后端 + 上下文注入，无前端改动） | 新增 `tests/unit/application/task-report-notice.test.ts`（5：三状态文案 / note 空与非空 / 不点名 `task_assign`）、`tests/unit/application/context-delegated-tasks.test.ts`（4：空不注入 / 任务行与"据此继续" / 超 8 条截断 / 无备注不留空括号）、`tests/integration/server/task-report-continuation.test.ts`（1：脚本化网关端到端——pm 沿出边派单 → dev 领取并汇报 done → **pm 收到含"继续"的通知并真的发起下一步 `task_assign`** + 预览可见 `delegated-tasks` 块）；`npm test` **53 files / 343 tests 全绿**；`coverage` 142/142、`ratchet` 0、`typecheck`/`eslint`/`build` 通过（产物未变）；**"是否真的继续干活"须用户在真实项目点验一次**，见 `docs/changes/2026-09-16-s36-task-report-loop.md` |
| 2026-09-16（S37） | 暂停/停止的回合中断语义修复（用户报告"暂停无效"；prd D40；后端 + 少量前端文案） | 新增 `tests/integration/server/pause-interrupt.test.ts`（2：回合中途暂停的完整闭环〔中断信号在模型调用途中到达 → `state{turnAborted}` → 只有 1 个回合 → `queued=2` → `resume` 补处理 2 条〕+ 无在途回合时 `aborted=false`）、`tests/unit/web/stop-feedback.test.ts`（4）；**先复现后修复并反向验证**（退掉修复分别红在 ④/⑥）；`npm test` **55 files / 349 tests 全绿**；`coverage` 142/142、`ratchet` 0、`typecheck`/`eslint`/`build` 通过；**"按暂停输出立刻停"须用户在真实项目点验**，见 `docs/changes/2026-09-16-s37-pause-interrupt.md` |
