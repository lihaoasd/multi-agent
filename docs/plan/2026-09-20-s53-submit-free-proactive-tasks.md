# S53 方案：产出物登记免审批 / 角色主动续领任务 / 取消「受阻」状态

> 日期：2026-09-20　类型：用户口径（三条）　真源：`prd` FR-07 / FR-08 / FR-13、`workspaces-artifacts.md` §6、`data-storage.md` §7、`agent-runtime.md` §4/§6
> 关联：`docs/changes/2026-09-20-s53-submit-free-proactive-tasks.md`、`docs/plan/development.md`
> 用户原话：**"1. 提交产出物不用审批 2. 角色完成任务时要主动查看任务列表是否还有任务，不能只等待唤醒，游客任务列表有多个任务存在 3. 任务没有受阻概念，受阻可能是角色没有执行没有完成导致"**

## 1 需求与根因

| # | 用户口径 | 现场诊断 |
| --- | --- | --- |
| ① | 提交产出物不用审批 | `PolicyEngine` 把 `kind='submit'` 交给项目 `artifactPolicy`（`docSubmitApproval` 默认 **true**）判定——**默认配置下每次 doc 类登记都要用户点一次批准**。设计文档（`workspaces-artifacts.md` §6 与 2026-09-09 用户要求）**早就写着"登记免审批"**，实现与设计、与用户口径都不一致（文档漂移） |
| ② | 角色完成任务时要主动查看任务列表是否还有任务，不能只等待唤醒 | 角色在一轮 loop 里**没有"回头看还有没有活"的动作**：`task_update` 成功后只回一句"已汇报任务 t_x → done"就结束回合，`[当前任务]` 块也只说"完成后用 task_update 汇报"。于是**任务栏里明明还躺着派给它的 todo 任务**，它却停下来等唤醒——与 S50/D53 修掉的"7 小时没人领"是同一根因的另一半：S50 解决了"看得到待领取"，这轮要解决"会主动再去看" |
| ③ | 任务没有受阻概念 | `task_update` 接受 `blocked`，`TASK_STATES`/`TASK_TERMINAL_STATES`、`PATCH /tasks/:tid`、右栏/任务面板的状态选择器、`taskReportNotice()` 都带着它。真实数据里 `blocked` 也确实被当成"停在这"用（架构师/开发各留了一条），但**平台没有任何"解阻"机制**：没有谁负责把 `blocked` 推回 `in_progress`，它就是一条**没人接手的终点**——正如用户说的"受阻可能是角色没有执行没有完成导致"。**活体证据**：项目 `p_mu9ksdagz3qwc` 里 `u_qa_1` 于 12:51:27Z 直接去 `task_claim` 那条 `blocked` 任务，被"任务当前状态不可领取：blocked"挡住（PM 随后只能另派一条新任务 `t_mu9skcvanvjpw` 才把活续上） |

## 2 改动

| # | 改动 | 落点 |
| --- | --- | --- |
| ① | **`kind='submit'` 一律免审批** | `src/domain/rules/policy.ts`：在通用审批规则**之前**直接 `allow`（`ruleId='SUBMIT_FREE'`）。网络离线等 deny 仍在更前面（不放松安全边界）。`artifactPolicy`（`docSubmitApproval`/`codeSubmitApproval`）与 `APPROVAL__*` 配置项**保留字段、标 `@deprecated`**——不迁移既有 `project.json`，但**不再是登记的门** |
| ② | **汇报/领取都带出"名下剩余任务"** | `src/infra/tools/builtin/task.ts`：`task_update` 成功文案追加 `pendingHint()`（名下 `todo`+`in_progress` 清单 + "不要等唤醒，立即 `task_claim`"；已清空则明说"你名下已没有未完成任务"）；`task_claim` 成功文案追加 `remainingTodoHint()`（还有几条待领取）。读列表失败**不影响**汇报结果（提示只是附加信息） |
| ③ | **提示词层把"主动续领"写成规矩** | `context-builder.ts`：`platform-role` 增两句——"产出物登记**不需要审批**，不要为交东西发审批"与"每汇报完一条**立刻** `task_list` 复核并续领，确认名下没活了再结束这一轮"；`[当前任务]`（`task-context`）同样加一句"汇报 done 之后不要停下等唤醒"；`pending-tasks` 的出路指引去掉 `blocked` |
| ④ | **取消「受阻」** | `task_update` 的状态枚举只留 `done`/`terminated`，收到 `blocked` 返回 `ERR_VALIDATION` 并说明该怎么走；`TaskService.setState` 对 `blocked` 直接拒绝（覆盖 `PATCH /tasks/:tid` 等所有入口）；任务面板的状态选择器不再提供「受阻」 |
| ⑤ | **历史数据只读兼容** | `blocked` **保留**在 `TaskState`/`TASK_STATES`/`TASK_TERMINAL_STATES`（既有 `tasks.jsonl` 不改写、`task_list?state=blocked` 仍可筛）；界面把它显示为「受阻（旧数据）」/「未完成（旧受阻）」，**仍留在右栏待办列表**里——这类任务正需要用户再看一眼（改派或终止），藏起来才是真丢活 |

**不改**：`task_assign` 出边约束、单工槽位（每 Agent 至多 1 个 `in_progress`）、`done`/`terminated` 前的 code artifact 结算、`terminated` 语义、审批通道本身（高危命令照旧走审批，`approval_result`/`tool_result` 照旧留痕）、`previewRef` 机制。

## 3 验证方式

| 层 | 手段 |
| --- | --- |
| 单元（策略） | `tests/unit/domain/policy.test.ts` 新增：**项目把 `docSubmitApproval`/`codeSubmitApproval` 都打开**时，doc 与 code 的 `kind='submit'` 仍判 `allow`/`SUBMIT_FREE`（旧实现必红） |
| 单元（工具） | 新增 `tests/unit/infra/task-tools.test.ts`（7 条）：`blocked` 被拒且文案指出路；枚举只暴露 `done`/`terminated`；`done` 后带出剩余任务（**只含自己名下**，不含他人）；名下清空时不催；读列表失败不影响汇报文本；`claim` 后提示还有几条待领取；只有一条时不追加提醒 |
| 单元（服务） | `tests/unit/application/task-question-service.test.ts`：规则 24 改用 `terminated`；新增"`blocked` 迁移被拒且任务状态不变" |
| 回归 | `npm test` **66 files / 410 tests 全绿**；`coverage` 143/143、`ratchet` 0、`typecheck`/`eslint`/`build` 通过 |
| **用户点验** | ① 让角色登记产出物：**不再出现审批卡**，`manifest` 立即出现新版本；② 给某角色一次派 2 条任务：它做完第一条后**自己接着领第二条**（会话流里能看到第二次 `task_claim`），不再等唤醒；③ 任务面板的状态选择器**没有「受阻」**；既有 `blocked` 任务仍显示（标"旧数据"）在右栏 |

## 4 风险

| 风险 | 对策 |
| --- | --- |
| 免审批被当成"登记不再留痕" | 登记照旧写 `manifest` + 版本快照 + 署名 + `tool_result` 审计；只是不再要用户点批准 |
| 高危动作被顺带放行 | 免审批只匹配 `kind==='submit'`（`artifact_submit` 声明 `risk:'low'`）；`deny`（离线联网、越界路径）与 `risk:'high'`/`needsApproval` 的工具仍走原规则 |
| 老 `blocked` 记录变成"看不见的活" | 不做数据迁移、不隐藏：`TASK_STATES` 保留 `blocked`，界面标"旧数据"并继续列在右栏待办；用户可改派或终止 |
| 角色被"续领"逼成空转 | 提示是**条件式**的（名下无 todo 时明说"已没有未完成任务"）；工具结果只是文本，不强制再跑一轮模型 |
| `pendingHint` 让工具结果变长 | 只列 `#id [state] title` 一行一条；`task_update` 输出上限 2000 字符，超长按既有策略截断 |
| 提示词变长影响每轮 token | 净增 3 句短句；同时删掉 `pending-tasks` 里过时的 `task_update done/blocked` 措辞 |
