# 开发方案 · 移除会议功能（会议相关需求彻底删除）

> 类别：plan · 状态：已完成（2026-09-14） · 类型：需求变更（删除型）· 执行结果见 [修改记录](../changes/2026-09-14-remove-meeting.md)
> 关联：[prd.md](../requirements/prd.md)、[architecture.md](../design/architecture.md)、[sessions.md](../design/sessions.md)、[data-storage.md](../design/data-storage.md)、[agent-runtime.md](../design/agent-runtime.md)、[memory.md](../design/memory.md)、[tools.md](../design/tools.md)、[sandbox.md](../design/sandbox.md)、[contract.md](../api/contract.md)、[plan.md](../testing/plan.md)、[deploy.md](../operations/deploy.md)

## 1. 背景与需求

用户要求：**删除会议功能**。

当前仓库处于"设计文档体系保留、实现已清空"的重启状态（HEAD `0217e21`），因此本次变更**只改设计文档与配置模板，不涉及代码**。

### 1.1 澄清结论（2026-09-14 用户确认）

| 问题 | 结论 |
| --- | --- |
| 删除范围 | **彻底移除**：删除 `docs/design/meetings.md`，所有文档清掉 meeting 会话类型/状态机/工具/事件/端点/配置键，只保留 user 会话 |
| 已定稿决策 | **直接删掉相关决策条目**（D2 整条；D14-⑤/⑥/⑩；D16-① 及 ②③④ 中的会议部分；D17-②/③ 及 ⑦ 的会议部分；D18-① 及 ②⑤ 中的会议部分） |
| 拍板能力是否别处保留 | **不需要**，"会议相关需求彻底去掉"；阻塞式用户交互只保留既有审批机制 |

## 2. 本次采用的判断（显式记录，可推翻）

1. **编号不复用**：US / FR / D 的编号保持稳定，被删条目留下**空缺**，并在列表处加一行说明空缺原因。
   理由：需求与决策 ID 一旦复用，所有历史引用（其它文档、git 历史、评审记录）都会指向另一件事；重编号的收益低于风险。
   例外：`testing/plan.md` 的测试规则是**内部清单**且未被任何文档按号引用，本次直接**重排序号**（25 条 → 21 条），不保留空缺。
2. **`ask_user`/提问/「需你处理」待办条一并删除**：按"不保留拍板通道"的结论，删除 `contract.md` 的 `/questions` 端点、WS `question.asked`/`question.answered`、上行 `decision`，以及 D17-③ 待办条（其三类聚合源中两类属会议，仅剩的高危审批已有原位审批卡片）。
   若后续要恢复"user 会话内 Agent 提问"，应作为独立需求重新设计并另起编号。
3. **重建 `docs/plan/` 与 `docs/changes/` 两个目录**：两者在重启提交中被删除，但项目开发标准要求"方案先行 + 修改记录"；本次变更按原约定路径落盘。
4. **`docs/design/meetings.md` 直接删除**（不是归档到别处）；如需回溯，可从 git 历史 `5d210bc` 或本次变更前的工作区版本取回。

## 3. 影响分析（逐文件）

| 文件 | 会议相关命中 | 处理 |
| --- | --- | --- |
| `docs/design/meetings.md` | 全篇 | **删除文件** |
| `docs/design/sessions.md` | 会话类型/状态机/§3/§4/§6 | **整体重写**（仅 user 会话） |
| `docs/requirements/prd.md` | US-4/5/6、FR-09/11/14/20/23、D1/2/11/14/15/16/17/18、§1/§3/§8/§9/§10 | 逐条删除/改写 |
| `docs/design/architecture.md` | §4 模块树 3 处、§5.2 全节、§6/§7/§11 | 删除会议模块与流程，§5.3 上移为 §5.2 |
| `docs/design/agent-runtime.md` | §2 状态机（含 meeting 态）、§2 不变式、§3 长任务暂停类型、§6 工具表 4 行 | 三态状态机；删除 meeting_* 工具行 |
| `docs/design/data-storage.md` | §4.1 meta（type/host/agenda/state 注释）、§4.2 `meeting_event` kind、§5 记忆类型、§7 task 注释 | 删除/改写 |
| `docs/design/memory.md` | §1 可见性、§3.2 会议纪要整节、§4 类型与全局写规则、§6 恢复表 2 行 | 删除/改写 |
| `docs/design/tools.md` | §2 命名/availableIn、§3 清单 4 行、§4 矩阵行、说明 2 条、§6 | 删除/改写 |
| `docs/design/sandbox.md` | §3.2 一处（会议内可读） | 改写 |
| `docs/design/workspaces-artifacts.md` | 无会议正文 | 不改 |
| `docs/api/contract.md` | §2 会议 7 端点、§2 questions 2 端点、§3 上行 1/下行 3、§4 错误码 2 行 | 删除 |
| `docs/testing/plan.md` | 规则 2/14/16/21/22、规则 7/17/18、分层说明、E2E、Mock 说明 | 删除/改写，其余规则序号前移（25→21 条） |
| `docs/operations/deploy.md` | `MEETING__*` 3 键 | 删除 |
| `.env` / `.env.example` | `MEETING__*` 3 键 + 分区注释 | 删除 |
| `docs/plan/`、`docs/changes/` | 目录不存在 | 新建（本方案 + 修改记录） |

## 4. 实施步骤

1. 新建 `docs/plan/2026-09-14-remove-meeting.md`（本文件）。
2. 删除 `docs/design/meetings.md`；重写 `docs/design/sessions.md`。
3. 按 §3 逐文件修改（PRD 的 US/FR 留空缺并加一行说明；D 系列逐条删改）。
4. 修改 `.env` 与 `.env.example`。
5. 全库复核：`grep -i "会议|meeting|拍板|主持人|议程|纪要|question|待办条"` 应只剩"编号空缺说明"一类有意保留的表述。
6. 检查文档内 Markdown 链接是否全部可解析（`meetings.md` 的引用必须清零）。
7. 写 `docs/changes/2026-09-14-remove-meeting.md`，逐条对应本次 diff。

## 5. 验证方式

- **无残留**：会议/meeting/主持人/议程/纪要/拍板/等待用户决策/`MEETING__*` 在 `docs/`、`.env*` 中不再出现（除 PRD 的空缺说明与本方案自身）。
- **测试规则连续**：`testing/plan.md` 规则 1~21 连续无空缺，且不含会议相关规则。
- **引用完整**：所有 `](...)` 相对链接指向存在的文件。
- **状态机自洽**：Agent 三态（idle/working/waiting）在 `agent-runtime.md`、`sessions.md`、`data-storage.md`、`contract.md` 四处口径一致；会话类型只剩 `user`。
- **配置自洽**：`.env` / `.env.example` / `deploy.md` 的键集合一致。
- **diff 审计**：每一处改动都能追溯到"删除会议"这一需求，未夹带无关修改。

## 6. 明确不在本次范围（保持原样，另行裁决）

以下在《当前设计情况》盘点中被列为待裁决项，本次**不动**：

- 私有工作区 / `ws://` / `ws_read` / `ws_write` 的下线未同步（P0-1）
- doc 提交是否审批（P0-2）、产出物面板与回退入口（P0-3）
- 任务通道默认值 `TASK__ASSIGN_BY_AGENT`（P0-4）
- 事件规范三套词汇（P0-6）、`config.yaml` 残留（P0-7）、模型 provider id 不一致（P0-8）、锁机制四说（P0-9）
- 断链 `docs/README.md`、`docs/frontend/style.md`、`docs/plan/development.md` 的补齐
- `src/`、`web/`、`tests/`、`package.json` 的重建

> 注：`meetings.md` 删除后，`frontend/style.md`（已缺失）的引用减少 2 处，但其它断链仍在。

## 7. 风险与回滚

| 风险 | 应对 |
| --- | --- |
| 误删与会议无关的内容 | 逐文件对照 §3 命中清单；改后跑残留 grep + 链接检查 |
| 编号空缺被误读为文档损坏 | 在 US/FR/测试规则列表处各加一行"空缺=已移除，编号不复用"说明 |
| 判定有误（如应保留拍板能力） | 全部改动集中在 13 个文件，`git revert` 或 `git show 5d210bc:docs/design/meetings.md` 可恢复；本方案 §2 已显式记录判断依据 |
