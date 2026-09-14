# 开发方案 · 取消私有工作区，改为共享工作目录 + 文件归属锁

> 类别：plan · 状态：已完成（2026-09-14） · 类型：需求变更（口径收敛）· 执行结果见 [修改记录](../changes/2026-09-14-shared-workdir.md)
> 关联：[prd.md](../requirements/prd.md)、[workspaces-artifacts.md](../design/workspaces-artifacts.md)、[tools.md](../design/tools.md)、[sandbox.md](../design/sandbox.md)、[agent-runtime.md](../design/agent-runtime.md)、[architecture.md](../design/architecture.md)、[data-storage.md](../design/data-storage.md)、[contract.md](../api/contract.md)、[plan.md](../testing/plan.md)、[deploy.md](../operations/deploy.md)

## 1. 需求

用户指令（2026-09-14）：**"私有工作区删除，都在项目目录进行，文档所有角色共享，只有自己的才能修改。"**

拆成三条可验收规则：

| # | 规则 |
| --- | --- |
| R1 | **无私有工作区**：不存在 `ws://` 路径、`ws_read`/`ws_write` 工具、`workspaces/` 目录、`scope=workspace` 概念 |
| R2 | **所有产出都在项目工作目录内进行**（受控编辑 / 产物登记 / 受控命令三条通道不变） |
| R3 | **文件共享可读、写入按归属**：工作目录内所有文件对全部角色可读；只有 `file-owners` 记录的 owner（或尚无归属的文件）可被写入，他人文件一律拒改（用户本人不受限） |

## 2. 背景：这是一次"未同步"的收口

私有工作区在 2026-09-12 的实现期已被取消，但只有 `tools.md`、`workspaces-artifacts.md`、`data-storage.md` 的部分位置被改到；`prd`、`architecture.md`、`agent-runtime.md`、`sandbox.md` 仍写着私有工作区（即《当前设计情况》盘点中的 P0-1）。本次按用户口径把 5 份文档与配置全部对齐。

## 3. 本次采用的判断（显式记录，可推翻）

1. **FR-06 / D3 / D12 / D13① / D14-⑨ / D16-⑥ 就地改写，不删号**：这些条目描述的能力（工作空间、提交制、目录受限、实例停用保留数据）本身仍然存在，只是"私有"变"共享 + 归属"，属于口径修订而非需求删除，因此沿用原编号。
2. **删除而非保留"已下线"痕迹**：`ws://` 行、`ws_write` 灰行、矩阵里的"私有工作区读写（ws_*）"整行、`workspaces/` 目录项、`scope: workspace` 枚举值、`ws_*` 命名族一律删除；`workspaces-artifacts.md` 只保留一句"取消私有工作区"的历史说明。
3. **`memory_append` 的 scope**：`workspace(记忆)` → `platform(记忆)`，使 `scope` 枚举收敛为 `workdir | readonly-global | platform`。
4. **不动 `contract.md:10` 的 `ws://host/ws`**：那是 WebSocket 协议地址，与工作区无关（易误改，特别标注）。
5. **补一条测试规则**：把 R3（共享可读 + 归属写）加入 `testing/plan.md` 规则清单（追加为规则 21，不重排既有编号）。
6. **无主文件首写认领保留**：用户既有仓库里的文件没有归属记录，首个写入者认领；否则 Agent 无法在既有代码库上工作。

## 4. 影响面（63 处命中）

| 文件 | 需要处理的位置 |
| --- | --- |
| `prd.md` | US-3、FR-06、FR-13、§6 安全边界、D3、D12、D13①、D14-⑨、D16-⑥、§9 验收 4 |
| `architecture.md` | §1 原则、§5.1 上下文、§5.2 提交制流程、§6 领域模型、§7 一致性表、§8 边界 |
| `agent-runtime.md` | §1 多实例说明、§2 停用说明、§6 工具表（fs 行 + 删 ws 两行）、§6 路径边界 |
| `data-storage.md` | §1 原则 2、§2 `workspaces/` 目录、§2 注、§6 manifest `fromWorkspaceRel` 与说明 |
| `tools.md` | §2 scope 枚举、allowedRoots 注释、命名规范、工具清单 3 行、§3 可用根说明、§4 矩阵行、§6 结尾说明 |
| `sandbox.md` | §3.1 路径表、§3.2 校验流程/互不可见/只读例外/工具级可用根、§4.1 脚本写法、§8 失败表、§10 验收 |
| `workspaces-artifacts.md` | 头部变更说明、§1 空间表（三类→两类）、§2 与 §2.2 措辞、§5 审计 |
| `contract.md` | 团队 DELETE 端点说明（去掉"工作区"） |
| `deploy.md` | 备份表第 4 行（去掉"工作区"） |
| `testing/plan.md` | 追加规则 21（共享/归属） |
| 无需改动 | `memory.md`、`.env`、`.env.example`（无相关工作区内容） |

## 5. 实施步骤

1. 新建本方案。
2. 按 §4 逐文件修改（顺序：prd → architecture → agent-runtime → data-storage → tools → sandbox → workspaces-artifacts → contract → deploy → testing）。
3. 全库复核：`grep "私有|ws://|ws_read|ws_write|ws-self|workspaces/|工作区"`，除下列有意保留项外应清零：
   - `contract.md:10` 的 WebSocket 地址；
   - `workspaces-artifacts.md` 头部"取消私有工作区"历史说明；
   - 本方案与修改记录自身。
4. 链接检查 + 文档头完整性检查。
5. 写修改记录 `docs/changes/2026-09-14-shared-workdir.md`，逐条对应 diff。

## 6. 验证方式

- **R1**：`ws://`（除 WebSocket 地址）、`ws_read`/`ws_write`/`ws-self`、`workspaces/`、`scope: workspace` 全库 0 命中。
- **R2**：三条写通道（`workdir_edit` / `artifact_submit` / `cmd_run`）在工作目录内，`sandbox` 路径校验根只剩 `workdir ∪ ro://`。
- **R3**：`prd` FR-06、`workspaces-artifacts` §1/§2、`agent-runtime` §6、`sandbox` §3.2、`tools` §3、`testing` 规则 21 六处口径一致（全员可读 / 仅归属者可写 / 无主首写认领 / 用户不受限）。
- **diff 审计**：每处改动可追溯到 R1~R3。

## 7. 不在本次范围

- 锁机制描述尚未统一（"文件编辑会话锁" vs 归属锁 vs KeyedLock，P0-9）；
- doc 提交是否审批（P0-2）、产出物面板与回退入口（P0-3）、`TASK__ASSIGN_BY_AGENT` 默认值（P0-4）、事件规范三套词汇（P0-6）、`config.yaml` 残留（P0-7）、模型 provider id（P0-8）；
- 3 处历史断链（`frontend/style.md`、根 `README.md`、`plan/development.md`）。

## 8. 风险与回滚

| 风险 | 应对 |
| --- | --- |
| 误删共享读取能力（把"仅自己可读"读成"仅自己可见"） | R3 明确写"全员可读、仅归属者可写"，并在 PRD/workspaces/tools 三处重复确认 |
| 误改 WebSocket 地址 `ws://host/ws` | 步骤 3 的复核把该行列为允许保留项 |
| 判定有误（如需保留私有区做草稿） | 改动集中在 10 个文件，`git checkout HEAD -- <path>` 可恢复 |
