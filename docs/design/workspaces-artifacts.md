# 工作目录与产出物设计 · Agent Haness

> 类别：design · 状态：草稿(待评审) · 决策依据：D3（提交制）、D13（代码受控编辑路径 + 审批默认值）、prd FR-06/07、US-3/12
> 关联：[data-storage.md](data-storage.md)（manifest/归属表）、[agent-runtime.md](agent-runtime.md)（工具）、[architecture.md](architecture.md)
> **2026-09-14 变更（用户要求）**：**取消私有工作区**（`ws://` 路径与 `ws_*` 工具一并删除），所有角色的产出都在**项目工作目录**内进行；
> 目录内容**全员可读（角色间共享）**，产出带**署名**，**只有归属自己的文件才能修改**（他人产出物只读 + 另建新文件）。详见 §1/§2。

## 1. 两类空间与边界（谁在哪里放什么）

| 空间 | 位置 | 谁能写 | 放什么 |
| --- | --- | --- | --- |
| 项目工作目录(workdir) | 用户选定路径 | 经 `workdir_edit`（**唯一写通道**）与 `artifact_submit`（仅登记）；**按文件归属校验**：只能改自己名下的文件；用户可自由改 | 全部产出：文档、设计稿说明、源码、配置、测试与部署文件 |
| 运行时项目文件夹其余部分 | `data/projects/<id>/` | 平台 | 会话日志/记忆/manifest/归属表/任务/审批（永不在 workdir） |

- **读（共享）**：工作目录内所有文件对**全部角色可读**，不设隔离区；角色通过 `fs_read_file`/`fs_list_dir`/`fs_search` 直接读项目目录。
- **写（归属）**：只能写 `file-owners` 归属自己的文件；尚无归属的文件（如用户既有仓库文件、首次产出）**首写即认领**；**用户本人**始终可改（不经该表校验）。

产出物类型注册表（MVP）：`doc`（PRD/架构/设计/规范）、`code`、`config`、`test`、`deploy`（脚本/手册/清单）。
每类型默认落地建议路径：doc→`workdir/docs/`，code→按仓库结构，test→`workdir/tests|test/`，deploy→`workdir/deploy/` 等（可配置；已有仓库以现结构为准；D14-②）。
> ui/ux 的设计稿/二进制产出（图片等）暂归 `doc` 子类（标注 design）或按需注册新类型；diff/内容预览仅支持文本文件（FR-16 为 P1）。（M14c）

## 2. 产出与署名（D3 提交制的 2026-09-14 修订）

**项目工作目录是唯一产出地**：所有角色的产出即刻可见，不存在"先在隔离区产出、提交后才进目录"的两段式。
写通道只有一条 —— `workdir_edit`（见 tools.md §6），它在写入前后各做一件事：

### 2.1 写前：归属校验（他人产出物不可改）

| 文件状态 | 结果 |
| --- | --- |
| 无归属记录（如用户既有仓库文件、首次产出） | **允许**写入；写完即认领 |
| 归属 = 自己 | 允许（`edits` 计数 +1、更新最近修改时间） |
| 归属 = 他人 | **拒绝** `ERR_FORBIDDEN`，消息点名 owner，提示"另建新文件"（如加版本后缀） |

不提供转交/接管（用户明确选择"只读 + 新建文件"）；**用户本人**始终可改（不经该表校验）。

### 2.2 写后：署名（`file-owners.jsonl`）

```
{ relPath, owner: "dev_1", ownerName: "高级开发", firstAt, lastAt, edits, lastTaskId, via: "workdir_edit"|"artifact_submit" }
```

- 一行一个文件；`ownerName` 即**署名**（角色显示名），随团队配置变化以最近一次写入为准。
- 供三处使用：① 系统提示 [`我的产出物（可改）` / `他人产出物（只读）`]，让角色知道"自己在哪改自己的东西"；
  ② `GET /api/projects/:pid/file-owners`（含 `?owner=` 过滤）；③ 写入回执（`已编辑 …｜署名 高级开发（dev_1）`）。

### 2.3 产出物登记（`artifact_submit`）

把项目目录里**已经写好**的文件登记为一条产出物：版本快照（`artifact-versions/<id>/v<n>/`）+ `artifacts.jsonl` manifest + 署名；
**不移动文件、不涉及审批**（用户 2026-09-09 要求提交免审批）。登记同样受归属校验：不能把他人文件登记/覆盖成自己的。

### 2.2 代码受控编辑路径（code，兼顾真实开发可测试性；D13① 确认）

开发 Agent 在 **workdir（用户选定目录/仓库）内就地**直接编辑源码（这是让 install/build/test 闭环成立的必要条件），约束为：

- 编辑仅经 `workdir_edit` 工具（作用域 workdir、风险 low→审计）：每次写文件记录**变更审计**（文件/行级 diff 摘要），session log 留 `tool_call/tool_result`；完整补丁落入版本存储（data-storage §6 versionDir）；
- **任务级聚合（D14-⑧/D17-①）**：`workdir_edit` 的改动归属**当前激活任务**（taskId 由 dispatcher 注入——任务来自用户 UI 派单或**上游 Agent 沿编排图出边委派**（D19-④⑤）；激活规则=每 Agent 至多 1 个 `in_progress`（D17-①：已有时新任务不可置位、可先 todo；无自动回退），todo/口头指派不入上下文→对应改动按回合兜底）。聚合时机=任务被标记 done（用户确认 dev 汇报）、**用户终止任务前结算**（D17-①：终止确认可一键触发，先结算快照再置 `terminated`）或 Agent 显式 `artifact_submit(type=code)`；此时生成 type=code artifact（文件清单=该任务全部变更，diffSummary 汇总）→ 用户右栏看到"dev_1 提交了 登录模块(12 文件, +860/-120) v1"，manifest 条目带 `taskId`（**无审批门默认初始 state=approved**，B1，与 §4 状态机一致）；
- 跨回合/跨会话的同一任务，改动持续累计到该任务的 artifact 版本；任务未 done 前用户经右栏实时看到累计 diff（只读展示，不影响未结算编辑）；
- 策略（artifactPolicy.codeSubmitApproval 默认 false）可改为"代码提交也需审批"；
- 回退内容依据 = artifact-versions 存储的补丁/快照（data-storage §6），不依赖 git；git 仓库场景仅作为可选的用户侧提示，平台不自动操作 git。

> 为什么不做隔离区：在隔离区改完再拷回，Agent 无法在工作目录里运行构建/测试验证；而"在工作目录直接改 + 全量留痕 + 版本记录 + 写入按归属限制"既保证可验证，也满足"带署名、可回退"的提交制精神（2026-09-08 用户确认此路径，见决策 D13①）。

## 3. 回退（Rollback）

- 触发：用户右栏对某 artifact 版本点"回退"（或 Agent 在用户批准下回退自己的提交）。
- 语义：将该版本涉及的 relPath 恢复为前序版本内容——内容依据 = `artifact-versions/<artifactId>/v<n>/` 的快照/补丁（data-storage §6，H2 定稿）；新版本记录 state=reverted，不物理删历史。
- 前置校验：目标文件自该版本后被其他提交/外部修改过时，先提示差异与冲突风险（用户可选先备份），不静默覆盖。
- 与 git 的关系：平台回退不依赖 git、不自动操作 git；若 workdir 是 git 仓库且存在未提交改动，回退前提示冲突风险（可选先备份）。

## 4. 产出物状态机与可见性

```
(产出直接写 workdir) ──artifact_submit 登记──▶ approved   （2026-09-09：登记免审批）
approved ──回退──▶ reverted
```

- **不在界面设"产出物"栏**（2026-09-09 用户要求）：提交即交付，工作目录里的文件本身就是可见结果；manifest（artifacts.jsonl）仍为唯一记录，供审计与回退接口使用（回退无 UI 入口）。
- manifest（artifacts.jsonl）为唯一记录；工作目录文件本身用户可用任意工具查看。

## 5. 审计与防呆

- 越界写入（非 workdir 的路径）→ 拒绝 + `error` 事件（工具层强制，见 agent-runtime §6）。
- **归属锁（2026-09-12 取代原"跨 Agent 编辑锁"设想）**：`file-owners.jsonl` 记录每个文件的 owner；
  非 owner 写入 → `ERR_FORBIDDEN`（点名 owner 并提示另建文件）；无主文件首写认领。写入后再更新署名与 `edits`。
- 未声明目标文件的受控编辑：`workdir_edit` 要求每次声明 relPath；批量/覆盖写需 high 审批。
- 删除工作目录既有文件（未经提交上下文）→ high 审批。
- 所有登记/回退/审批决策都落 approvals/artifacts/file-owners 文件与 session log（双写一致性由事件总线保证）。
- **已知边界**：`cmd_run` 的命令副作用不按 owner 校验（无法静态判定命令会写哪些文件）；回退接口当前无 UI 入口。

## 6. 审批默认值（已确认，D13②）与 P1 预留

已确认的默认策略（项目/系统均可配置为更强审批）：

| 动作 | 默认 |
| --- | --- |
| 静态产物提交（doc/config/deploy 文档/test 报告等，经 artifact_submit） | **无需审批**（2026-09-09 用户要求：提交即落地，初始 state=approved） |
| 代码类提交（workdir_edit 按任务聚合，type=code） | **无需审批**（code 门，初始 state=approved），全程留痕（diff 审计 + manifest + versionDir 补丁） |
| 高危命令 | **需审批**（见 agent-runtime §6） |

> 自 2026-09-12 起产出**直接写进项目工作目录并署名**（§2），产出物登记只是"再给它一个版本快照"；
> `artifactPolicy`（docSubmitApproval/codeSubmitApproval）配置项仍在 project.json 与 `.env` 的 `APPROVAL__*` 中保留（项目数据模型），但当前**不读该策略**。

P1 预留（MVP 不做）："阶段基线锁定"——把某个 artifact 集合（如某评审节点）锁定为基线，后续改动需先解锁/评审。

## 7. 实现口径（2026-09-15，S6）

- **写通道落地**：`workdir_edit` 经 `PathResolver`（`workdir://` 边界 + 符号链接逃逸拦截）解析为工作目录内 relPath，再由 `WorkdirFs` 二次防御（拒绝绝对路径、盘符与 `..`）；写前查 `file-owners`（无主放行 / 自己放行 / 他人 → `ERR_FORBIDDEN` 并点名 `ownerName`），写后按 `via='workdir_edit'` 署名并累加 `edits`。
- **编辑锁（M5）**：同一 `(projectId, relPath)` 的并发编辑由 `LockManager.tryLock` 拦截——命中即返回 `ERR_CONFLICT`（不排队、不覆盖），规则 12。
- **未结算改动**：每次 `workdir_edit` 追加一行到 `projects/<pid>/pending/<key>.jsonl`（`key=task-<taskId>` 或回合兜底 `turn-<sessionId>-<turn>`），只记**首次** `base`（内容依据）+ 最近 `after` 哈希；`artifact_submit`/任务 done/终止结算时组装版本并把它移档到 `pending-settled/`（可审计、不会重复结算）。
- **版本内容（补丁类与快照类的统一存放）**：`artifact-versions/<artifactId>/v<n>/` 下 `manifest.json`（文件表 + diffText）、`diff.patch`（统一 diff，审计）、`files/<i>/<flat>`（提交后内容）、`base/<i>/<flat>`（提交前内容，新增文件缺省）。
  ⚠️ 设计原文要求"code 回退=补丁反向应用"：实现同时保存 `diff.patch` 与 base 内容，回退直接写回 base（与反向应用等价且不引入补丁解析风险）。
- **版本递增**：同一提交者 + 同题 + 同任务再次登记 → 复用同一 `artifactId` 且 `version+1`（`prevVersion` 链），跨回合/跨会话持续累计（D14-⑧）。
- **回退**：目标版本之后文件被改动过 → `ERR_CONFLICT` + `detail.conflicted[]`（用户确认后 `force=true` 覆盖）；回退产生 `state=reverted` + `revertedTo` 的新版本，不物理删历史。
- **审批门（§6 与 §4 的口径冲突处理）**：`artifact_submit` 是否需审批**由项目 `artifactPolicy` 决定**（`docSubmitApproval`/`codeSubmitApproval`，`PolicyAction.kind='submit'`），策略拒绝时不产生 manifest 条目（审计在 session log 的 `approval_result`/`tool_result`）；任务级聚落（settle）不走审批门，直接 `state=approved`（B1 口径）。审批卡带 `previewRef`（doc 类提交的只读预览引用）。
- **任务级聚合**：`workdir_edit` 的 `taskId` 由运行时注入（当前 `in_progress` 任务）；`done`/`terminated` 前 `TaskService` 先 `settle` 生成 `type=code` artifact（文件清单=该任务全部变更）并回写 `artifactIds`（可回退）。
- **未做**：托盘批量同意/信任开关 UI（D17-④，留 S8）；回退的 UI 入口已在项目页「任务与产出物」提供（用户侧以提交者身份代行）。
