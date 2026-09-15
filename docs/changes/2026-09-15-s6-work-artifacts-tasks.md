# 修改记录 · S6 产出物、任务、询问

> 类别：changes · 日期：2026-09-15 · 关联方案：[docs/plan/2026-09-15-s6-work-artifacts-tasks.md](../plan/2026-09-15-s6-work-artifacts-tasks.md) · 总计划：[development.md](../plan/development.md) §6
> 关联设计：[workspaces-artifacts.md](../design/workspaces-artifacts.md)、[data-storage.md](../design/data-storage.md) §6/§7、[tools.md](../design/tools.md)、[agent-runtime.md](../design/agent-runtime.md) §4、[contract.md](../api/contract.md)

## 1. 需求 / 问题

S5 结束时 Agent 只会"说"：没有写通道（`workdir_edit` 未实现），成果无法登记/回退；任务与询问只有文件 schema，无法发布→领取→汇报，也不能向用户提问等待答复。7 个基础包里 `artifact`/`task` 仍是"已声明未实现"（规则 4/10/12/15/16/17/18/21/24/25 无实现）。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| ports | `ports/workdir.ts`、`ports/artifact.ts`、`ports/task.ts`、`ports/question.ts`（新增）、`ports/{policy,tools,lock,tokens}.ts` | 工作目录读写、产出物/归属/未结算改动、任务、询问端口；策略增 `submit` 动作；工具上下文增询问桥与 `approvalId`；锁增 `tryLock`；tokens 25 → 29 |
| shared | `shared/artifacts.ts`（新增） | 产出物类型/状态、任务状态、询问状态、署名方式、`pendingKeyFor` |
| domain | `domain/rules/diff.ts`（新增）、`domain/rules/policy.ts` | LCS 行级 diff/统一 patch；产出物登记的审批门判定 |
| infra | `infra/fs/workdir-fs.ts`、`infra/file-store/{artifact-store,task-store,question-store}.ts`、`infra/lock/keyed-lock.ts`、`infra/tools/builtin/{artifact,task,question,index}.ts`、`infra/tools/packages.ts` | 工作目录读写（含越界防御）；manifest/版本目录/归属表/未结算改动；任务与询问存储；`tryLock`；9 个新工具与包元数据 |
| application | `application/artifact/artifact-service.ts`、`application/task/task-service.ts`、`application/question/question-service.ts`（新增）、`application/agent-loop/{context-builder,runner,preview}.ts`、`application/tools/tool-executor.ts`、`application/dispatcher/dispatcher.ts` | 写通道/登记/回退/聚合；任务闭环与通知；询问阻塞与答复；上下文增 `task-context`/`artifact-index`；审批桥返回 `approvalId`、询问桥接入；waiting 计入 pending 询问 |
| server | `server/http-routes/work.ts`（新增）、`server/app.ts` | artifacts/versions/rollback/file-owners/pending-edits、tasks、questions 接口 |
| bootstrap | `bootstrap/{composition-root,main}.ts` | 端口与服务装配、`notify`（系统消息 + drain）|
| web | `web/src/api/work.ts`、`web/src/pages/WorkPanel.tsx`（新增）、`web/src/pages/ProjectModule.tsx` | 「任务与产出物」页签 |
| docs | `docs/api/contract.md`、`docs/design/{workspaces-artifacts,data-storage,tools,agent-runtime}.md`、`docs/plan/development.md` | 契约与设计回写（含 §6 审批门口的冲突处理）|
| tests | 5 个新文件 35 条 | 规则 4/10/12/15/17/21/24/25 |

## 3. 关键决定

1. **归属锁 + `tryLock`**：他人文件 `ERR_FORBIDDEN`（点名 ownerName）；并发编辑同文件 `ERR_CONFLICT`（规则 12 的"编辑锁命中"）。
2. **未结算改动按 key 暂存**（任务优先、回合兜底），只记首次 `base`；落袋移档 → 幂等且可审计。
3. **版本目录同时保存提交后内容与 base**：code 回退用 base 回写（= 补丁反向应用的等价实现），并保留 `diff.patch` 供审计。
4. **同题再登记版本递增**（复用 artifactId + `prevVersion`），跨回合累计。
5. **回退冲突前置校验**：`ERR_CONFLICT` + `detail.conflicted[]`，`force=true` 才覆盖。
6. **审批门口径**：`artifact_submit` 按项目 `artifactPolicy` 判定（`PolicyAction.kind='submit'`），拒绝时不建 manifest 条目；任务级聚合直接 `approved`（B1）。审批卡带 `previewRef`。
7. **任务单一激活**：`in_progress` 唯一，领取/置位都拦；`todo` 不入上下文；`done`/`terminated` 先结算 code artifact。
8. **通知与唤醒在组合根收口**：`notify = 系统消息 + dispatcher.drain`，服务层只回调（失败不阻断）。
9. **询问不新增事件 kind**：记录文件为真源 + WS 广播；会话 log 侧由工具事件审计。

## 4. 验证结果

| 验证项 | 结果 |
| --- | --- |
| 类型检查 | `npm run typecheck` 0 错误 |
| 测试 | **39 files / 266 tests 全通过**（S6 新增 5 文件 35 条） |
| 门禁 | `npm run lint` exit 0；`npm run ratchet` 越层违规 0；`npm run build` 成功 |
| 规则 21 | 演示：`pm_1` 首写认领 edits=1 → 续写 edits=2；`dev_1` 改他人文件 `ERR_FORBIDDEN`「归属于 项目经理（pm_1）」；`GET /file-owners` 返回署名 |
| 规则 4 | 演示：登记 → `a_…` v1（1 文件 +3/-0，state=approved）；再登记 → 同 id v2（prevVersion=1）；manifest 与版本目录（`manifest.json`+`diff.patch`）落盘 |
| 规则 10 | 演示/用例/HTTP：回退 v1 → v3 `state=reverted revertedTo=1`，文件回到该版本之前；改动冲突 → `ERR_CONFLICT`（`detail.conflicted=['docs/prd.md']`），`force` 后内容与快照一致 |
| 规则 12 | 演示/HTTP：任务内编辑落 `pending/task-<id>`（files=1, +1/-0）→ `PATCH tasks/:tid done` → artifact `type=code`（files=`src/login.ts`, taskId 正确）；终止任务同样先结算；并发编辑 `ERR_CONFLICT` |
| 规则 15/17 | 演示/用例：`todo` 时 `activeFor=null`；第二个任务领取 `ERR_CONFLICT`（holding 点名）；终止前结算可回退快照 |
| 规则 24 | 演示/用例/HTTP：发布 201（去重 200 `duplicate:true`，`force` 强制新建）；领取 `in_progress`；done/blocked/terminated 回报委派人（用户创建的静默） |
| 规则 25 | 演示/用例/HTTP：提问 pending + `hasPending=true`；第二问 `ERR_QUESTION_PENDING`；答复唤醒等待者（回注 choice）；必答缺失 `ERR_VALIDATION`、重复答复 `ERR_CONFLICT`；`GET /questions?status=` 可查 |
| 上下文同源 | `GET .../system-prompt`：`in_progress` 时出现 `task-context`（含任务标题），`artifact-index` 列署名归属与最近产出物 |
| 前端 | `vite build` 成功；项目页「任务与产出物」= 派单 / 改状态 / 待答询问就地答复 / 产出物版本与回退 / 署名表 |
| 遗留 | 托盘批量与信任开关 UI、`task_assign` 出边约束（S7）、`config/deploy` 逐条审批差异化（S8） |

## 5. 未做 / 回滚

- 未做：托盘批量同意/信任开关 UI（D17-④）、编排图出边校验（S7）、二进制/富文本产出预览（FR-16，P1）、回退前的自动备份文件（当前仅 `force` 确认）。
- 回滚：删除 `src/ports/{workdir,artifact,task,question}.ts`、`src/shared/artifacts.ts`、`src/domain/rules/diff.ts`、`src/infra/fs/workdir-fs.ts`、`src/infra/file-store/{artifact-store,task-store,question-store}.ts`、`src/infra/tools/builtin/{artifact,task,question}.ts`、`src/application/{artifact,task,question}/`、`src/server/http-routes/work.ts`、`web/src/{api/work.ts,pages/WorkPanel.tsx}` 与对应测试，并还原 `context-builder`/`runner`/`preview`/`tool-executor`/`policy`/`lock`/`tokens`/`composition-root`/`app` 的改动；数据侧删除 `data/projects/<pid>/{artifacts.jsonl,file-owners.jsonl,tasks.jsonl,questions.jsonl,pending,pending-settled,artifact-versions}` 即彻底回退（不影响会话日志与记忆）。
