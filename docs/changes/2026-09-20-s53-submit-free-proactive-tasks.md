# 修改记录 · S53 产出物登记免审批 / 角色主动续领任务 / 取消「受阻」

> 类别：changes · 日期：2026-09-20 · 关联方案：[docs/plan/2026-09-20-s53-submit-free-proactive-tasks.md](../plan/2026-09-20-s53-submit-free-proactive-tasks.md)
> 关联设计：[policy 所在 domain](../design/architecture.md)、[workspaces-artifacts.md](../design/workspaces-artifacts.md) §6、[data-storage.md](../design/data-storage.md) §7、[agent-runtime.md](../design/agent-runtime.md) §4/§6、[prd](../requirements/prd.md) FR-07/FR-08 / D56 / D57

## 1. 需求 / 问题

用户三条口径：**① 提交产出物不用审批 ② 角色完成任务时要主动查看任务列表是否还有任务，不能只等待唤醒 ③ 任务没有受阻概念**。

- ① **实现与设计/口径不一致**：设计（`workspaces-artifacts.md` §6、2026-09-09 用户要求）写明"登记免审批"，但 `PolicyEngine` 把 `kind='submit'` 交给项目 `artifactPolicy` 判定，而 `docSubmitApproval` 默认 **true** ⇒ **默认配置下每次 doc 类登记都要用户点一次批准**。
- ② **"看得到"≠"会去看"**：S50/D53 加了 `pending-tasks` 块（每回合可⻅），但角色一轮 loop 里没有"回头看还有没有活"的动作——`task_update` 成功后只回一句"已汇报任务 t_x → done"就收工，任务栏里还躺着派给它的 todo 任务。
- ③ **`blocked` 是没人接手的终点**：平台没有任何"解阻"机制，真实数据里它被当成"停在这"用（架构师/开发各留一条），正如用户说的"受阻可能是角色没有执行没有完成导致"。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| domain | `src/domain/rules/policy.ts` | `kind='submit'` **一律** `allow`（`ruleId='SUBMIT_FREE'`），放在通用 `risk==='high' || needsApproval` 规则之前；`deny`（离线联网、越界）仍在更前面 |
| ports | `src/ports/policy.ts`、`src/ports/task.ts` | `docSubmitApproval`/`codeSubmitApproval` 标 `@deprecated`（字段保留兼容既有 `project.json`/`.env`）；`setState` 契约注明"不再接受新的 `blocked`" |
| application | `src/application/task/task-service.ts` | `setState` 对 `blocked` 返回 `ERR_VALIDATION`（覆盖 `PATCH /tasks/:tid` 等所有入口）；通知分支收窄为 `done`/`terminated`；`taskReportNotice()` 的 `blocked` 文案保留为**历史数据兼容** |
| application | `src/application/agent-loop/context-builder.ts` | `platform-role` 增"登记免审批"与"每汇报完一条立刻 `task_list` 复核并续领"；`[当前任务]` 增"汇报 done 后不要停下等唤醒"；`pending-tasks` 的出路指引去掉 `blocked`；`[委派任务]` 措辞"受阻或终止的" → "终止（没做完）的" |
| infra | `src/infra/tools/builtin/task.ts` | `task_update` 枚举 `['done','terminated']`，`blocked` 回 `ERR_VALIDATION` + 出路说明；成功文案追加 `pendingHint()`；`task_claim` 成功文案追加 `remainingTodoHint()` |
| infra | `src/infra/tools/builtin/artifact.ts` | 描述写明"登记免审批（S53/D56）"；注释说明 `artifactPolicy` 不再是登记的门 |
| shared | `src/shared/artifacts.ts` | 注释说明 `blocked` 为**只读历史值**（`TASK_STATES`/`TASK_TERMINAL_STATES` 保留，不做数据迁移） |
| web | `web/src/pages/WorkPanel.tsx` | 状态选择器改 `SELECTABLE_TASK_STATES`（**不含 blocked**）；`blocked` 显示为「受阻（旧数据）」 |
| web | `web/src/pages/RightColumn.tsx` | `blocked` 显示为「未完成（旧受阻）」，**仍留在右栏待办列表**（这类任务正需要用户再看一眼） |
| tests | `tests/unit/infra/task-tools.test.ts`（新 7）、`tests/unit/domain/policy.test.ts`（+1）、`tests/unit/application/task-question-service.test.ts`（+1、改 1） | 见 §4 |
| docs | `prd`（**D56**/**D57** + FR-07/FR-08 补注）、`workspaces-artifacts.md` §6/§7、`data-storage.md` §6/§7、`agent-runtime.md` §4/§6、`contract.md`、`README.md`、`plan/development.md`、`testing/plan.md`（规则 24）、验收阶段清单加 `s53` | 全链路回写 |

**未改**：`task_assign` 出边约束、单工槽位（每 Agent 至多 1 个 `in_progress`）、`done`/`terminated` 前的 code artifact 结算、`terminated` 语义、审批通道本身（高危命令照旧审批、审计照旧）、`approvalPolicy` 的数据结构与项目存储格式（只标废弃、不迁移）。

## 3. 关键决定

1. **"登记"不是"批准"**：登记只是给已经写进工作目录的产出物一个版本快照 + 署名，用户口径与设计一致——**不该有门**；安全边界仍由 `deny`（离线/越界）与高危动作规则守着。
2. **字段废弃但不删**：`artifactPolicy` 留在数据模型里（不迁移既有项目数据、不动 `APPROVAL__*` 配置项），只是**不再参与判定**；`@deprecated` 标注意图。
3. **"不能只等唤醒"要在两个层面同时成立**：提示词层（`platform-role`/`[当前任务]` 写成规矩）+ 工具结果层（每次汇报/领取都把"名下还剩什么"直接摆到模型眼前）——只改提示词容易在长上下文里被稀释，只改工具结果则缺少"这是你的职责"的分量。
4. **取消的是"新的受阻"，不是历史数据**：`blocked` 保留为只读状态（可筛、可显示、不做数据迁移）；界面标"旧数据/未完成"并**继续留在右栏待办**——这些任务正需要用户改派或终止，藏起来等于丢活。
5. **读列表失败不能影响汇报**：`pendingHint()`/`remainingTodoHint()` 出错就**不加提示**，汇报本身照旧成功（附加信息不该变成新的失败点）。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| 新增单测（工具） | `tests/unit/infra/task-tools.test.ts` **7 passed**：`blocked` 被拒且文案给出路（`done`/`terminated`/改派）；参数枚举只暴露 `done`/`terminated`；`done` 后带出剩余任务且**只含自己名下**（他人 `t_3` 不出现）、含 `task_claim` 与"不要等唤醒"；名下清空时回"你名下已没有未完成任务"；**读列表失败时文本恰为 `已汇报任务 t_1 → terminated`**（提示未污染）；`claim` 后提示还有 1 条待领取；只有一条时不追加提醒 |
| 新增单测（策略） | `policy.test.ts` 新增：项目把 `docSubmitApproval`/`codeSubmitApproval` **都打开**时，doc 与 code 的 `kind='submit'` 仍判 `allow`/`SUBMIT_FREE` |
| **反向验证** | 临时把策略改回"由 `artifactPolicy` 把门" → 新用例**实测红**：`{decision:"allow",ruleId:"SUBMIT_FREE"}` 变成 `{decision:"approval",ruleId:"TOOL_NEEDS_APPROVAL"}`（`policy.test.ts:117`）；恢复后 3 个文件 29 条全绿 |
| 单测（服务） | `task-question-service.test.ts`：规则 24 改用 `terminated`（原用 `blocked`，在新语义下会被拒）；新增"`blocked` 迁移被拒（`ERR_VALIDATION`）且任务状态保持 `in_progress`" |
| typecheck / eslint | 0 错误（src + web；其间修掉一处 TS 收窄：`setState` 里 `blocked` 提前返回后，通知分支的 `state === 'blocked'` 变成无重叠比较） |
| 全量测试 | `npm test` **66 files / 410 tests 全绿**（S52 后为 65 files / 401 tests） |
| 覆盖率 / 依赖门禁 | `npm run coverage` **143/143**；`npm run ratchet` 违规 **0** |
| 构建 | `npm run build` 通过；产物 `web/dist/assets/index-DLNtGdsI.js`（1,377.71 kB / gzip 431.41 kB） |
| **活体验证**（本机运行中的实例 `p_mu9ksdagz3qwc` 贪吃蛇，`tsx watch` 重启后） | ① `PATCH /api/projects/:pid/tasks/t_mu9sc4wo4msbr {state:"blocked"}` → **400 `ERR_VALIDATION`**：「任务没有「受阻」状态：请说明缺口后继续推进，确实做不下去就 terminated，或让发起人改派」（新守卫确实生效）② `GET .../tasks` 里历史 `blocked` 任务 `t_mu9sdmxe9f7t5` **仍可读、仍列出** ③ `GET /api/projects/:pid/agents/dev_1/system-prompt`（运行期同一 `ContextBuilder`）包含「产出物登记**不需要审批**」「每汇报完一条**立刻**用 task_list 复核名下任务并续领下一条」「汇报 done 之后**不要停下等唤醒**」「任务没有「受阻」状态」四句 ④ 重启前 15 分钟内的真实日志正好复现两个缺口：`u_qa_1` 12:51:27Z `task_claim` **被 `blocked` 状态挡住**（"任务当前状态不可领取：blocked"），以及 `u_ux_1` 做完 `artifact_submit`+`task_update` 后**回合直接结束、没有接着领下一条**（用户不得不追问"还有任务"），且那次 doc 登记**确实走了一次审批**（`ap_mu9scc42562en approved`） |
| **未覆盖** | 提示词与工具结果的"行为效果"无法在本机自动化：**须用户点验** —— ① 登记产出物不再弹审批卡；② 一次派 2 条任务时角色做完第一条会**自己接着领**第二条（会话流里能看到第二次 `task_claim`）；③ 任务面板状态选择器无「受阻」，既有 `blocked` 任务仍显示为旧数据 |
| 说明 | 与 S15~S52 的交付口径一致 |

## 5. 遗留

- **历史 `blocked` 任务的去留由用户决定**：平台不迁移、不自动改派；右栏把它们标成"未完成（旧受阻）"列着，用户可改派或终止。若要"一键把旧 blocked 收成 terminated 并通知委派人"，需要一个显式的一次性操作入口（未做）。
- **`artifactPolicy` 字段彻底删除**：目前只标废弃（保兼容）；等确认没有外部脚本读 `APPROVAL__DOC_SUBMIT_APPROVAL` 后再删配置项与 `project.json` 字段。
- **"主动续领"仍是软约束**：靠提示词 + 工具结果文本；模型仍可能汇报完就收工。若要硬保证，可在 `task_update done` 后由平台**确定性地**在下一回合注入"你还有 N 条待领取任务"（相当于把 `pending-tasks` 的触发从"回合开始"延伸到"汇报之后"）——本轮先观察实际效果。
- **`task_list` 默认 `mine=true`**：角色想"看全项目还有没有需要自己接手的工作"要显式传 `mine=false`；提示词里已让"名下没活时"用它复核，但白名单里没有"抢别人未指派任务"的语义（任务始终有 assignee）。
