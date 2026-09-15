# 开发方案 · S6 产出物、任务、询问

> 类别：plan · 状态：已完成（2026-09-15）· 类型：**实现** · 总计划：[development.md](development.md) §6 · 执行结果见 [修改记录](../changes/2026-09-15-s6-work-artifacts-tasks.md)
> 关联：[workspaces-artifacts.md](../design/workspaces-artifacts.md)、[data-storage.md](../design/data-storage.md) §6/§7、[tools.md](../design/tools.md)、[agent-runtime.md](../design/agent-runtime.md) §4、[contract.md](../api/contract.md)

## 1. 目标与范围

让"研发团队"真正产出与协作：Agent 能把文件写进项目工作目录并**署名**（且改不了别人的），把成果**登记成可回退的产出物**；任务能**发布→领取→汇报**闭环，且**每 Agent 同时只干一件事**；Agent 需要决策时能**向用户提问并阻塞等待**，用户答复后续跑。

| 在范围内 | 不在范围内（后续阶段） |
| --- | --- |
| `workdir_edit`（唯一写通道）+ `file-owners` 归属校验与署名 | 托盘批量同意/信任开关 UI（D17-④，S8） |
| `artifact_submit` + manifest + `artifact-versions`（快照/补丁）+ 回退 | 阶段基线锁定（P1） |
| 任务发布/领取/汇报/去重/单 `in_progress`/终止前结算 | 编排图出边约束（`ERR_ORCHESTRATION_EDGE`，S7） |
| `ask_user` 阻塞与答复续跑（`waiting` 投影） | 未完成回合恢复三选（S8） |
| doc 提交审批门（按 `artifactPolicy`）+ `previewRef` 预览引用 | 代码提交审批的差异化策略细化 |
| 前端「任务与产出物」页签（任务/询问/产出物/署名四块） | 右栏三列表与工作日志折叠（S7） |

## 2. 关键决定

1. **归属锁取代编辑锁**：写前查 `file-owners`（无主放行 / 自己放行 / 他人 `ERR_FORBIDDEN` 点名 ownerName）；写后按 `via` 署名并累加 `edits`；**用户本人不受校验**（不经工具写）。并发编辑同一文件由 `LockManager.tryLock` 拦截 → `ERR_CONFLICT`（规则 12 的"编辑锁命中"）。
2. **未结算改动按 key 暂存**：`pending/<key>.jsonl`（`key=task-<taskId>` 优先，无任务按回合兜底 `turn-<sessionId>-<turn>`），只记**首次** `base`（回退内容依据）+ 最近哈希；落袋后移档 `pending-settled/`，天然幂等、可审计。
3. **版本目录同时存快照与 base**：`v<n>/files/...`（提交后）+ `v<n>/base/...`（提交前）+ `diff.patch`。设计要求的"code 回退=补丁反向应用"用 base 回写实现（等价但不引入补丁解析风险），已回写设计文档。
4. **同题再次登记版本递增**：同提交者 + 同题 + 同任务复用同一 `artifactId`，`version+1`、`prevVersion` 链接，跨回合/跨会话持续累计（D14-⑧）。
5. **回退冲突前置校验**：目标版本之后文件被改动过 → `ERR_CONFLICT` + `detail.conflicted[]`；用户确认后 `force=true` 覆盖；回退产生 `state=reverted` 新版本（不物理删历史，规则 10）。
6. **审批门口径统一**：`artifact_submit` 是否需审批由项目 `artifactPolicy` 决定（`PolicyAction.kind='submit'`，`docSubmitApproval`/`codeSubmitApproval`），**任务级聚合不走审批门**（B1：无审批门初始 `state=approved`）。这解决了 workspaces-artifacts §6"当前不读该策略"与 §4 状态机的冲突，已回写设计。
7. **任务状态机单一约束**：每 Agent 至多 1 个 `in_progress`（领取与置位都被拦，`detail.holding` 点名占用任务）；`todo` 不入上下文；`done`/`terminated` 前**先结算**未结算改动为 `type=code` artifact 并回写 `artifactIds`（可回退）。
8. **通知与唤醒收口在组合根**：任务发布/回报/询问答复都通过注入的 `notify`（系统消息进对方 user 会话 + `dispatcher.drain`）实现"唤醒一轮"（D18-③），失败只记日志、不阻断落库。
9. **`waiting` 由询问派生**：`dispatcher.status` 的 waiting = 有占用 且（有 pending 审批 或 **有 pending 询问**），不新增持久化状态（D18-④）。
10. **询问无新事件 kind**：`questions.jsonl` 是记录真源，广播 `question.asked`/`question.answered`；会话 log 侧由 `tool_call`/`tool_result` 审计（不新增未登记的 kind，D18-⑤d）。

## 3. 交付物

| 步骤 | 交付物 |
| --- | --- |
| S6.1 端口 | `ports/workdir.ts`、`ports/artifact.ts`、`ports/task.ts`、`ports/question.ts`；tokens 25 → 29；`ports/policy.ts` 增 `submit` 动作；`ports/tools.ts` 增 `askUser` 桥与 `approvalId`；`ports/lock.ts` 增 `tryLock` |
| S6.2 纯函数 | `domain/rules/diff.ts`（LCS 行级 diff / 摘要 / 统一 patch） |
| S6.3 infra 存储 | `infra/fs/workdir-fs.ts`、`infra/file-store/{artifact-store,task-store,question-store}.ts`、`keyed-lock.tryLock` |
| S6.4 应用服务 | `application/artifact/artifact-service.ts`、`application/task/task-service.ts`、`application/question/question-service.ts` |
| S6.5 工具 | `infra/tools/builtin/{artifact,task,question}.ts` + `builtin/index.ts` 注册（9 个新工具）|
| S6.6 上下文 | `context-builder.ts` 增 `task-context`/`artifact-index`（含署名归属）；`runner.ts` 注入任务/产出物/询问桥；`preview.ts` 同源 |
| S6.7 server | `http-routes/work.ts`（artifacts/tasks/questions/file-owners/pending-edits）、`app.ts` 接入、`dispatcher` waiting 收口 |
| S6.8 装配 | `composition-root.ts`：注册 4 个端口 + 3 个服务 + `notify`（系统消息 + drain）|
| S6.9 前端 | `api/work.ts`、`pages/WorkPanel.tsx`、`ProjectModule` 增「任务与产出物」页签 |
| S6.10 测试 | `domain/diff`(6)、`infra/s6-stores`(6)、`application/artifact-service`(7)、`application/task-question-service`(10)、`integration/work-api`(6) = 35 条 |

## 4. 验证方式与结果

| 验证项 | 方式 | 结果 |
| --- | --- | --- |
| 类型检查 / 门禁 | `npm run typecheck` / `lint` / `ratchet` / `build` | 0 错误 / exit 0 / 越层违规 0 / vite 构建成功 |
| 测试 | `npm run test` | **39 files / 266 tests 全通过**（S6 新增 5 文件 35 条） |
| 规则 21 共享与归属 | 演示 + 用例 + HTTP | `pm_1` 首写认领（edits=1）→ 续写（edits=2）→ `dev_1` 改他人文件 `ERR_FORBIDDEN` 点名「项目经理」；`GET /file-owners` 可见署名 |
| 规则 4 提交制 | 演示 + 用例 + HTTP | `artifact_submit` 写 manifest + `v1/manifest.json` + `diff.patch`；再次登记 → 同 id `v2`（prevVersion=1）；`GET /artifacts`/`/versions` 可见 |
| 规则 10 回退一致性 | 演示 + 用例 + HTTP | 回退 v1（add）→ 文件被删除（回到 v1 之前）；文件被后续改动时 `ERR_CONFLICT` + `detail.conflicted`，`force=true` 覆盖后内容与快照一致；新版本 `state=reverted`+`revertedTo` |
| 规则 12 任务级聚合 | 演示 + 用例 + HTTP | 进行中任务的 `workdir_edit` 落到 `pending/task-<id>`（files=1, +1/-0）；任务 done → 结算 `type=code` artifact（files=`src/login.ts`, taskId 正确）；`GET /pending-edits` 落袋后 files=0；并发编辑 `ERR_CONFLICT` |
| 规则 15/17 激活与终止 | 演示 + 用例 | `todo` 的 `activeFor=null`；第二个任务领取 `ERR_CONFLICT`（holding 点名）；终止前结算 code artifact（`state=approved`、可回退） |
| 规则 24 领取与汇报 | 演示 + 用例 + HTTP | 发布 201 / 去重 200；领取 in_progress；done/blocked/terminated 回报委派人（用户创建不通知自己）|
| 规则 25 询问 | 演示 + 用例 + HTTP | 提问 pending + `hasPending=true`（waiting 依据）；第二个提问 `ERR_QUESTION_PENDING`；答复唤醒等待者并回注答案；必答缺失 `ERR_VALIDATION`、重复答复 `ERR_CONFLICT` |
| 上下文同源 | `GET .../system-prompt` | `task-context` 只在 `in_progress` 时出现并含任务标题；`artifact-index` 列出我的/他人的产出物与署名 |
| 前端 | `npm run build` | 构建成功；项目页新增「任务与产出物」（派单/改状态/待答询问就地答复/产出物版本与回退/署名表）|

## 5. 不做与遗留

- 托盘批量同意与信任开关 UI（D17-④）、`config/deploy` 逐条审批的差异化（规则 18）留 S8。
- `task_assign` 的编排图出边约束（`ERR_ORCHESTRATION_EDGE`）留 S7（当前委派只落库与通知）。
- 回退的"先备份"提示仅以 `force` 确认表达；文件二进制/diff 预览（FR-16）仍是 P1。
- `cmd_run` 的命令副作用不做归属校验（无法静态判定写哪些文件）——设计已知边界。
