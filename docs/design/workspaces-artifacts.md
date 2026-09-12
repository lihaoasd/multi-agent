# 工作区与产出物设计 · Agent Haness

> 类别：design · 状态：草稿(待评审) · 决策依据：D3（提交制）、D13（代码受控编辑路径 + 审批默认值）、prd FR-06/07、US-3/12
> 关联：[data-storage.md](data-storage.md)（manifest）、[agent-runtime.md](agent-runtime.md)（工具）、[architecture.md](architecture.md)

## 1. 三类空间与边界（谁在哪里放什么）

| 空间 | 位置 | 谁能写 | 放什么 |
| --- | --- | --- | --- |
| 私有工作区 | 运行时项目 `workspaces/<instanceId>/` | **仅该 Agent**（用户 UI 默认不可见） | 草稿、中间分析、实验脚本、研究笔记、待提交文档定稿 |
| 项目工作目录(workdir) | 用户选定路径 | 仅经**提交服务/受控编辑**写入（用户可自由改） | 正式产出物：文档产物、源码、配置、测试与部署文件 |
| 运行时项目文件夹其余部分 | `data/projects/<id>/` | 平台 | 会话日志/记忆/manifest/任务/审批（永不在 workdir） |

产出物类型注册表（MVP）：`doc`（PRD/架构/设计/规范）、`code`、`config`、`test`、`deploy`（脚本/手册/清单）。
每类型默认落地建议路径：doc→`workdir/docs/`，code→按仓库结构，test→`workdir/tests|test/`，deploy→`workdir/deploy/` 等（可配置；已有仓库以现结构为准；D14-②）。
> ui/ux 的设计稿/二进制产出（图片等）暂归 `doc` 子类（标注 design）或按需注册新类型；diff/内容预览仅支持文本文件（FR-16 为 P1）。（M14c）

## 2. 提交制（D3）—— 两种产出路径

草稿/中间物永远留在私有工作区；进入工作目录的正式产出必须有**提交记录**（署名/版本/可回退）。

### 2.1 静态产物路径（doc/config/deploy 样板等）

```
Agent 在私有区产出/迭代草稿(drafts/) → 定稿
  → 调用 artifact_submit{type,title,summary,files:[{rel,action,fromWorkspaceRel}]}
  → 提交服务校验（类型合法/relPath 在工作目录内/源文件存在）
  → 若审批策略要求(type=doc 默认需审批，可配置) → 提交服务生成**只读预览**（文本=内容预览；二进制/设计稿=文件信息+大小）随审批卡提供并落审批记录 previewRef（D16-⑥，不开放私有区整体浏览）→ approval → approved 后执行
  → 拷贝写入 workdir + 写入版本快照(artifact-versions，回退依据) + 写 artifacts.jsonl 新版本 + 事件推送
  → 版本=一次提交记录(可含多文件清单)：同 relPath 的后续修改产生新版本，追溯以 versionDir 快照为准
```

### 2.2 代码受控编辑路径（code，兼顾真实开发可测试性；D13① 确认）

开发 Agent 在 **workdir（用户选定目录/仓库）内就地**直接编辑源码（这是让 install/build/test 闭环成立的必要条件），约束为：

- 编辑仅经 `workdir_edit` 工具（作用域 workdir、风险 low→审计）：每次写文件记录**变更审计**（文件/行级 diff 摘要），session log 留 `tool_call/tool_result`；完整补丁落入版本存储（data-storage §6 versionDir）；
- **任务级聚合（D14-⑧/D17-①）**：`workdir_edit` 的改动归属**当前激活任务**（taskId 由 dispatcher 注入——乙模式下任务来自用户 UI 指派；激活规则=每 Agent 至多 1 个 `in_progress`（D17-①：已有时新任务不可置位、可先 todo；无自动回退），todo/口头指派不入上下文→对应改动按回合兜底）。聚合时机=任务被标记 done（用户确认 dev 汇报）、**用户终止任务前结算**（D17-①：终止确认可一键触发，先结算快照再置 `terminated`）或 Agent 显式 `artifact_submit(type=code)`；此时生成 type=code artifact（文件清单=该任务全部变更，diffSummary 汇总）→ 用户右栏看到"dev_1 提交了 登录模块(12 文件, +860/-120) v1"，manifest 条目带 `taskId`（**无审批门默认初始 state=approved**，B1，与 §4 状态机一致）；
- 跨回合/跨会话的同一任务，改动持续累计到该任务的 artifact 版本；任务未 done 前用户经右栏实时看到累计 diff（只读展示，不影响未结算编辑）；
- 策略（artifactPolicy.codeSubmitApproval 默认 false）可改为"代码提交也需审批"；
- 回退内容依据 = artifact-versions 存储的补丁/快照（data-storage §6），不依赖 git；git 仓库场景仅作为可选的用户侧提示，平台不自动操作 git。

> 为什么代码不绕道私有区：在私有区改完再拷回，Agent 无法在工作目录里运行构建/测试验证；而"在真仓库直接改 + 全量留痕 + 版本记录"既保证可验证，也满足"显式进入共享目录、带署名、可回退"的提交制精神（2026-09-08 用户确认此路径，见决策 D13①）。

## 3. 回退（Rollback）

- 触发：用户右栏对某 artifact 版本点"回退"（或 Agent 在用户批准下回退自己的提交）。
- 语义：将该版本涉及的 relPath 恢复为前序版本内容——内容依据 = `artifact-versions/<artifactId>/v<n>/` 的快照/补丁（data-storage §6，H2 定稿）；新版本记录 state=reverted，不物理删历史。
- 前置校验：目标文件自该版本后被其他提交/外部修改过时，先提示差异与冲突风险（用户可选先备份），不静默覆盖。
- 与 git 的关系：平台回退不依赖 git、不自动操作 git；若 workdir 是 git 仓库且存在未提交改动，回退前提示冲突风险（可选先备份）。

## 4. 产出物状态机与可见性

```
draft(私有区，无 manifest) ──提交──▶ approved        （2026-09-09：提交免审批，直接落地）
approved ──回退──▶ reverted
```

- **不在界面设"产出物"栏**（2026-09-09 用户要求）：提交即交付，工作目录里的文件本身就是可见结果；manifest（artifacts.jsonl）仍为唯一记录，供审计与回退接口使用（回退无 UI 入口）。
- manifest（artifacts.jsonl）为唯一记录；工作目录文件本身用户可用任意工具查看。

## 5. 审计与防呆

- 越界写入（非 workspace/workdir 的路径）→ 拒绝 + `error` 事件（工具层强制，见 agent-runtime §6）。
- 未声明目标文件的受控编辑：`workdir_edit` 要求每次声明 relPath；批量/覆盖写需 high 审批。
- 删除工作目录既有文件（未经提交上下文）→ high 审批；提交中的 delete action 需显示受影响文件。
- **跨 Agent 文件锁（M5 定稿）**：file-store 维护"编辑会话锁"（内存 + runtime.state 持久化）：某 relPath 处于 Agent A 未结算的受控编辑中时，Agent B 的 `workdir_edit`/提交命中该文件 → `ERR_CONFLICT` 并提示协调；任务聚合/结算后释放锁。（MVP 每模板单实例已大幅降低同文件并发概率，锁是兜底。）
- 所有提交/回退/审批决策都落 approvals/artifacts 文件与 session log（双写一致性由事件总线保证）。

## 6. 审批默认值（已确认，D13②）与 P1 预留

已确认的默认策略（项目/系统均可配置为更强审批）：

| 动作 | 默认 |
| --- | --- |
| 静态产物提交（doc/config/deploy 文档/test 报告等，经 artifact_submit） | **无需审批**（2026-09-09 用户要求：提交即落地，初始 state=approved） |
| 代码类提交（workdir_edit 按任务聚合，type=code） | **无需审批**（code 门，初始 state=approved），全程留痕（diff 审计 + manifest + versionDir 补丁） |
| 高危命令 | **需审批**（见 agent-runtime §6） |

> `artifactPolicy`（docSubmitApproval/codeSubmitApproval）配置项仍在 project.json/config.yaml 中保留（项目数据模型），但 `artifact_submit` 当前**不读该策略**：产出物提交一律直落。

P1 预留（MVP 不做）："阶段基线锁定"——把某个 artifact 集合（如某评审节点）锁定为基线，后续改动需先解锁/评审。
