# 修改记录 · 移除会议功能（2026-09-14）

> 类别：changes · 类型：需求变更（删除型）· 方案：[docs/plan/2026-09-14-remove-meeting.md](../plan/2026-09-14-remove-meeting.md)
> 需求来源：用户指令"会议功能删除"，澄清结论见方案 §1.1

## 1. 改了什么

删除了设计体系中全部与会议（meeting）相关的内容：会话类型、状态机、工具、事件、REST 端点、WS 事件、错误码、记忆类型、配置键、测试规则与决策条目。Agent 状态由四态（idle/working/**meeting**/waiting）收敛为**三态**（idle/working/waiting）；平台 MVP 只保留 `user` 会话。

按"不保留拍板通道"的结论，一并删除了 `ask_user`/提问/「需你处理」待办条（`/questions` 端点、WS `question.*`、上行 `decision`、D17-③）；阻塞式用户交互只保留既有**审批**机制。

## 2. 逐文件改动

| # | 文件 | 改动 |
| --- | --- | --- |
| 1 | `docs/design/meetings.md` | **整文件删除** |
| 2 | `docs/design/sessions.md` | 重写：会话类型只剩 `user`；状态机只剩 active/suspended/archived；删除会议挂起、meeting 会话 id、`meeting.*` 事件 |
| 3 | `docs/requirements/prd.md` | 删除 US-5/US-6、FR-09/FR-20、D2、U5；改写 §1 目标、§3 角色表、US-4、FR-11/14/23、D1/D11/D14(⑤⑥⑩)/D15/D16(①②③④)/D17(②③⑦)/D18(①②⑤)、§8 边界、§9 验收脚本、§10 说明；补 3 处"编号空缺"说明 |
| 4 | `docs/design/architecture.md` | 删除 `application/meeting/` 模块、§5.2 会议流程整节（§5.3 → §5.2）、ws 推送/fsm/装载顺序/项目删除校验/页面表 6 处会议文字；`Session{type: user}` |
| 5 | `docs/design/agent-runtime.md` | 状态机与不变式改为三态；删除"进入会议挂起"、"会议抢占"暂停类型；删除 4 个 `meeting_*` 工具行；两级状态映射与忙碌停用边界改写 |
| 6 | `docs/design/data-storage.md` | meta 删除 `host`/`agenda`、type 改 `user`、状态注释收敛；删除 `meeting_event` kind；记忆类型去掉 `meeting_summary`；task creator 注释改写 |
| 7 | `docs/design/memory.md` | L2 行去掉 `meeting_summary`；可见性去掉会议日志；删除 §3.2 会议纪要整节；L3 类型与全局写规则改写；恢复表删除 2 行 |
| 8 | `docs/design/tools.md` | 删除 `meeting_*` 4 行工具与矩阵行；`availableIn` 改 `["user"]`；`user+meeting` → `user`；删除"会议内工具降级"与"主持人例外"两条说明；命名规范去掉 `meeting_*`；清理 1 处指向已删决策（D14-⑩）的悬空引用 |
| 9 | `docs/design/sandbox.md` | §3.2 工具级可用根说明去掉"会议内均可"，并清理 1 处指向已删决策（D14-⑩）的悬空引用 |
| 10 | `docs/api/contract.md` | 删除会议 6 端点、questions 2 端点、上行 `decision`、下行 `meeting.event`/`question.*`；删除 `ERR_MEETING_BLOCKED`/`ERR_MEETING_FULL`；`ERR_CONFLICT` 与 `session.updated` 注释改写 |
| 11 | `docs/testing/plan.md` | 删除会议相关规则 5 条与 3 处会议描述；规则重排为 1~20（连续）；E2E 路径与 Mock 说明改写 |
| 12 | `docs/operations/deploy.md` | `.env` 键清单删除 `MEETING__ENABLED/AUTO_START/AUTO_CLOSE` |
| 13 | `.env` / `.env.example` | 删除 `MEETING__*` 3 键与"会议"分区注释（`.env` 分区标题改为"沙箱 / 任务 / 检索"） |
| 14 | `docs/plan/2026-09-14-remove-meeting.md` | 新建：本次方案 |
| 15 | `docs/changes/2026-09-14-remove-meeting.md` | 新建：本记录 |

## 3. 关键决定（可推翻）

1. **编号不复用**：US-5/US-6、FR-09/FR-20、D2 及条内空缺（D14-⑤/⑥/⑩、D16-①、D17-②/③、D18-①）保留空号，PRD 加说明；重编号会让历史引用指向另一件事。
2. **测试规则重排序号**（25 → 20 条）：规则号未被任何文档引用，属内部清单，不保留空缺。
3. **`ask_user`/提问一并删除**：按"不保留拍板能力，阻塞交互只留审批"执行；若日后需要，应作为独立需求重新设计并另起编号。
4. **恢复 `docs/plan/` 与 `docs/changes/` 目录**：两者随重启提交被删，本次按项目开发标准重新启用。

## 4. 验证结果

| 验证项 | 结果 |
| --- | --- |
| 全库残留 grep（`会议\|meeting\|主持人\|议程\|纪要\|拍板\|待办条\|question`，排除本方案/本记录） | **0 命中** |
| 会议状态枚举（`queued\|proposed\|blocked_waiting`） | **0 命中** |
| Agent 状态口径一致性（`idle/working/waiting`） | `agent-runtime.md`、`prd.md` D16-② 一致；`sessions.md`/`data-storage.md`/`contract.md` 会话类型只剩 user |
| 配置键一致性（`.env` / `.env.example` / `deploy.md`） | 三者均无 `MEETING__*` |
| 文档内 Markdown 链接 | `meetings.md` 引用清零；仅剩 3 处**本次范围外**的历史断链（`../frontend/style.md`、`../README.md`、`../plan/development.md`） |
| 测试规则编号 | 1~20 连续无空缺 |
| 文档头完整性（标题 + 元信息行） | 13 份文档全部正常 |

## 5. 未做（另需裁决）

- **顺带发现（未修）**：`.gitignore` 里的 `.env.*` 同时忽略了本应入库的 `.env.example`，而 `deploy.md` §3 写的是"`.env.example`（入库，可作为模板）"——模板实际不在版本控制内。
- 断链补齐：`docs/README.md`（术语表）、`docs/frontend/style.md`（UI 设计）、`docs/plan/development.md`（里程碑）；
- ~~私有工作区 / `ws://` / `ws_read`/`ws_write` 下线未同步~~ → **已于同日完成**，见 [2026-09-14-shared-workdir.md](2026-09-14-shared-workdir.md)；
- doc 提交是否审批、产出物面板与回退入口、`TASK__ASSIGN_BY_AGENT` 默认值、事件规范三套词汇、`config.yaml` 残留、模型 provider id 不一致、锁机制四说；
- 代码重建（`src/`、`web/`、`tests/`、`package.json`）。

## 6. 回滚

- 单个文件：`git checkout HEAD -- <path>`（本次改动尚未提交）。
- 会议文档：`git show 5d210bc:docs/design/meetings.md`。
- 全量回滚：`git checkout HEAD -- docs .env.example`（`.env` 为本地未跟踪/受忽略文件，需手工恢复 `MEETING__*` 三行）。
