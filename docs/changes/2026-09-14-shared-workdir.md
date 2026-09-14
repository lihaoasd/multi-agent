# 修改记录 · 取消私有工作区，改为共享工作目录 + 文件归属锁（2026-09-14）

> 类别：changes · 类型：需求变更（口径收敛）· 方案：[docs/plan/2026-09-14-shared-workdir.md](../plan/2026-09-14-shared-workdir.md)
> 需求来源：用户指令"私有工作区删除，都在项目目录进行，文档所有角色共享，只有自己的才能修改"

## 1. 改了什么

私有工作区（`ws://` 路径、`ws_read`/`ws_write` 工具、`workspaces/` 目录、`scope=workspace` 概念）从设计体系中**彻底删除**；所有角色的产出统一在**项目工作目录**内进行。

由此确立三条口径（写入 PRD FR-06 与 `workspaces-artifacts.md` §1/§2）：

- **读 = 共享**：工作目录内所有文件对**全部角色可读**，不设隔离区；
- **写 = 归属**：只能写 `file-owners` 归属自己的文件，他人产出物拒改（`ERR_FORBIDDEN` 并点名 owner），只能另建新文件；
- **无主文件首写认领**：用户既有仓库文件/首次产出没有归属记录，首个写入者认领；**用户本人**不受归属校验。

## 2. 逐文件改动

| # | 文件 | 改动 |
| --- | --- | --- |
| 1 | `docs/requirements/prd.md` | US-3、FR-06（改为"共享工作目录与文件归属"）、FR-13、§6 安全边界、D3、D12、D13①、D14-⑨、D16-⑥、§9 验收 4 共 10 处口径改写 |
| 2 | `docs/design/architecture.md` | §1 原则、§5.1 上下文、§5.2 提交制流程（改为"工作目录内直接产出 + 登记"）、§6 领域模型删除私有工作区节点、§7 并发写策略（改为归属校验）、§8 路径边界 |
| 3 | `docs/design/agent-runtime.md` | §1 多实例、§2 停用说明去掉"工作区"；§6 工具表：fs 行改为"全员可读"、**删除 `ws_write`/`ws_read` 两行**、`workdir_edit` 行补归属校验；§6 路径边界改写 |
| 4 | `docs/design/data-storage.md` | §1 原则去掉"工作区"；§2 删除 `workspaces/` 目录项；§2 注补共享/归属；§6 manifest 删除 `fromWorkspaceRel` 字段与"从 workspace 定稿拷贝"说明 |
| 5 | `docs/design/tools.md` | §2 `scope` 枚举去掉 `workspace`、allowedRoots 注释去掉 `ws-self`、命名规范去掉 `ws_*`；§3 删除 `ws_write` 行、fs 行改"全员可读"、`memory_append` scope 改 `platform(记忆)`；§3 可用根说明重写；§4 矩阵删除"私有工作区读写（ws_*）"行；§6 结尾说明重写 |
| 6 | `docs/design/sandbox.md` | §3.1 路径表删除 `ws://` 行；§3.2 校验根去掉 ws、"互不可见"改为"共享与归属"、"只读例外"与"工具级可用根"改写；§4.1 脚本写法改为 `workdir_edit`；§8 失败表路径提示改 `workdir/ro`；§10 验收改为归属测试 |
| 7 | `docs/design/workspaces-artifacts.md` | 标题改为"工作目录与产出物设计"；头部变更说明更新为 2026-09-14；§1 由"三类空间"改"两类空间"并删除私有区行、新增读/写两条规则；§2 标题与措辞更新；§5 删除"私有区工具已下线" |
| 8 | `docs/api/contract.md` | 团队 DELETE 端点说明去掉"工作区"（**未动 L10 的 WebSocket 地址 `ws://host/ws`**） |
| 9 | `docs/operations/deploy.md` | 备份表去掉"工作区" |
| 10 | `docs/testing/plan.md` | 追加规则 21（共享与归属：全员可读 / 非 owner 拒改 / 首写认领 / 用户不受限） |
| 11 | `docs/plan/2026-09-14-shared-workdir.md` | 新建：本次方案 |
| 12 | `docs/changes/2026-09-14-shared-workdir.md` | 新建：本记录 |
| — | `docs/changes/2026-09-14-remove-meeting.md` | 同步：原"未做→私有工作区未同步"一条改标为本次已完成 |

未改动：`memory.md`、`.env`、`.env.example`（无相关工作区内容）。

## 3. 关键决定（可推翻）

1. **FR-06/D3/D12/D13①/D14-⑨/D16-⑥ 就地改写，不删号**：这些能力（工作空间、提交制、目录受限、停用保留数据）仍存在，只是"私有"变"共享 + 归属"，属口径修订而非需求删除。
2. **删除而非保留"已下线"痕迹**：`ws://` 行、`ws_write` 灰行、矩阵里的 `ws_*` 行、`workspaces/` 目录项、`scope=workspace`、`ws_*` 命名族一律移除，只在 `workspaces-artifacts.md` 头部保留一句变更来源说明。
3. **无主文件首写即认领**保留：否则 Agent 无法在用户既有代码库上工作；这是 R3 的受控例外，已写进 FR-06 与 `sandbox.md` §3.2。
4. **文件名与链接保持 `workspaces-artifacts.md`**：仅改标题为"工作目录与产出物设计"，避免 5 份文档的链接改名（文件名与标题的轻微不一致留待统一重命名时处理）。

## 4. 验证结果

| 验证项 | 结果 |
| --- | --- |
| R1 `ws://` / `ws_read` / `ws_write` / `ws-self` / `workspaces/` / `scope=workspace` | **0 命中**（唯一保留项：`contract.md:10` 的 WebSocket 地址，已复核与工作区无关） |
| R2 产出通道 | `sandbox.md` §3.2 校验根只剩 `workdir ∪ ro://`；三条写通道（`workdir_edit`/`artifact_submit`/`cmd_run`）均在工作目录内 |
| R3 口径一致（六处） | `prd.md` FR-06、`workspaces-artifacts.md` §1/§2、`agent-runtime.md` §6、`sandbox.md` §3.2、`tools.md` §3、`testing/plan.md` 规则 21 一致 |
| "工作区" 词残留 | 仅 3 处"无/取消私有工作区"的变更说明（`tools.md`×2、`workspaces-artifacts.md`、`prd.md`×2） |
| 文档内 Markdown 链接 | 无新增断链；仍为 3 处历史断链（`frontend/style.md`、根 `README.md`、`plan/development.md`） |
| 文档头完整性 | 15 份文档标题与元信息行正常 |

## 5. 未做（另需裁决）

- 锁机制描述仍未统一（`sandbox.md` §4.2"文件编辑会话锁" vs 归属锁 vs `data-storage.md` §6.1 KeyedLock）——本次只把并发写策略改成"归属校验挡住"，未收敛术语；
- doc 提交是否审批、产出物面板与回退入口、`TASK__ASSIGN_BY_AGENT` 默认值、事件规范三套词汇、`config.yaml` 残留、模型 provider id；
- 3 处历史断链与 `.env.example` 被 `.gitignore` 忽略的问题；
- 代码重建。

## 6. 回滚

`git checkout HEAD -- docs/design/workspaces-artifacts.md docs/design/tools.md docs/design/sandbox.md docs/design/agent-runtime.md docs/design/architecture.md docs/design/data-storage.md docs/requirements/prd.md docs/api/contract.md docs/operations/deploy.md docs/testing/plan.md`（本次改动尚未提交）。
