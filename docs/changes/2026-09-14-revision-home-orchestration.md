# 修改记录 · 首页三模块 + 项目编排画布（2026-09-14）

> 类别：changes · 类型：需求变更（新增 + 修订）· 方案：[docs/plan/2026-09-14-revision-home-orchestration.md](../plan/2026-09-14-revision-home-orchestration.md)
> 需求来源：用户"需求修改"（首页工具/Agent/项目三模块；项目页拓扑画布 + 会话；右栏任务/询问/审批），两轮澄清结论见方案 §2

## 1. 改了什么

1. **首页三模块**：项目 / Agent / 工具，写进需求（US-15/16、FR-25~27）与界面设计（`ui.md`）。
2. **工具包**：工具按包组织，**7 个基础包全员必选**（`fs`/`cmd`/`memory`/`session`/`artifact`/`approval`/`task`），MVP 只展示；自定义/第三方包后续（U8/U11）。
3. **Agent 模块**：模板库只读展示 loop / 提示词 / 工具（按包）/ 模型 / 审批 + **场景标签**（`software` 现成、`general` 预留）；配置提交后续（U9/U10）。
4. **项目编排画布**：新增项目级有向图（节点=Agent 实例、边=可委派关系）、保存校验、节点状态徽标；**Agent 委派只能沿出边**（越权 `ERR_ORCHESTRATION_EDGE`）、**汇报沿同一边反向**、**用户不受边约束**。
5. **运行模型**：用户在 Agent 会话中对话＝让该 Agent 开工；各 Agent 独立工作；**不设项目级运行状态、不自动接力**；任务"发布→领取→执行→汇报"。
6. **运行控制**：只做 Agent 级**暂停/停止**（D19-⑥）；原 `TASK__ASSIGN_BY_AGENT` 开关**废弃**。
7. **询问机制恢复**：Agent→用户提问 + 阻塞等待（回归 `ask_user` 工具、`/questions` 接口、WS `question.*`），右栏询问列表承载；仍**不做**顶部待办条。
8. **布局改版**：项目页双导航——**拓扑页 2 栏**、**对话页 3 栏**；取消原三栏工作台的左栏 Agent 列表。

## 2. 新增文件

| 文件 | 内容 |
| --- | --- |
| `docs/README.md` | 文档地图 + **术语表**（编排图/委派/领取/询问/暂停/停止…）+ 编号索引（US/FR/D/U 规则与空缺说明）——同时修掉 PRD 的 `../README.md` 断链 |
| `docs/design/tool-packages.md` | 工具包模型：包字段、7 个内置基础包、挂载与生效链、展示契约、自定义包扩展位 |
| `docs/design/agent-templates.md` | Agent 与场景：三层模型归属、`scenario` 字段、首页展示字段与契约、配置提交待定项 |
| `docs/design/orchestration.md` | 编排图：铁律、数据模型、编辑校验、运行模型（对话即启动/领取制）、暂停停止、观测、接口与错误码 |
| `docs/design/ui.md` | 信息架构、首页三模块、拓扑页 2 栏、对话页 3 栏、右栏三列表、交互约定（**取代**已删的 `frontend/style.md`） |
| `docs/plan/2026-09-14-revision-home-orchestration.md` | 本次方案 |
| `docs/changes/2026-09-14-revision-home-orchestration.md` | 本记录 |

> 注：`docs/design/agents.md` 曾按此名字创建，但 Windows 不区分大小写，运行时把它识别成该目录的 `AGENTS.md` 指令文件并注入会话；已改名为 `agent-templates.md` 并同步全部引用。

## 3. 修订文件

| 文件 | 改动 |
| --- | --- |
| `docs/requirements/prd.md` | 新增 US-15~21、FR-25~33、决策 **D19**（①~⑧）、未决 **U8~U12**；修订 §3 PM 角色、FR-02、FR-08、FR-12、§6 实时性、**D15（乙模式口径作废，改为 Agent 委派 + 出边约束）**、§9 验收主路径 + 新增验收 6/7 |
| `docs/api/contract.md` | 新增首页库（`/api/tool-packages`、`/api/agent-templates`）、编排（`GET/PUT /orchestration`）、Agent 控制（`pause/resume/stop`）；恢复询问端点；WS 新增 `orchestration.updated` 与 `question.asked/answered`；错误码新增 `ERR_ORCHESTRATION_EDGE`/`ERR_ORCHESTRATION_INVALID`/`ERR_QUESTION_PENDING`；`frontend/style.md` 断链改指 `ui.md` |
| `docs/design/agent-runtime.md` | waiting 语义补"询问等待"；**停用/暂停/停止三者区别**；回合暂停类型改为三类；工具表新增 `ask_user`；`task_assign` 改为出边约束；任务工具段落去掉甲/乙模式；询问等待跨重启；任务上下文与状态流转口径更新 |
| `docs/design/data-storage.md` | 布局新增 `orchestration.json`、`questions.jsonl`；§7 新增 question 与 orchestration schema；模板结构增加 `scenario`/`packages`；task creator 口径更新 |
| `docs/design/tools.md` | 工具增加 `package` 字段；新增 `ask_user` 行；`task_assign` 加出边约束；`task_view/list` 改平台常驻；矩阵任务行改为 `✅³` + 脚注；说明补"工具包全员必选" |
| `docs/design/architecture.md` | 模块树新增 `application/orchestration/`、`application/tool-package/`；新增数据流 §5.2b 委派与领取；§10 接口清单更新；§11 页面表改为首页三模块 + 项目页双导航 |
| `docs/design/workspaces-artifacts.md` | 任务级聚合注明"任务来自用户派单或上游 Agent 出边委派" |
| `docs/design/agent-templates.md`（新） | 同上 |
| `docs/testing/plan.md` | 新增规则 22~26（编排保存校验、委派边约束、领取汇报闭环、询问阻塞与续跑、暂停/停止）；关联改为开发方案目录（修掉最后一处断链） |
| `docs/operations/deploy.md` | 备份表补任务/询问/编排图；`TASK__ASSIGN_BY_AGENT` 标注已废弃 |
| `.env` / `.env.example` | 删除 `TASK__ASSIGN_BY_AGENT`（开关废弃） |

## 4. 关键决定（可推翻）

1. **7 个基础包 = 现有 7 个工具域**；`workdir_edit` 归入 `artifact` 包。包不改变授权链（矩阵仍是工具级真源）。
2. **不设项目级运行状态**：删除"开始运行"概念；只有 Agent 级暂停/停止。
3. **汇报沿反向边**：边是"可委派"权限；完成/受阻回报属系统行为，不需要反向边。
4. **用户不受边约束**：用户可向任意 Agent 派单/终止（老板权限）。
5. **运行中可改拓扑**：边只影响未来委派，因此不做"先暂停再改图"。
6. **U 编号不复用**：新未决项用 U8~U12（原 U6/U7 已定案移除，故跳过）。
7. **画布库选型**（React Flow 候选）留到编码阶段定稿，本方案只定行为契约。

## 5. 验证结果

| 验证项 | 结果 |
| --- | --- |
| 文档内 Markdown 链接 | **0 处断链**（原 3 处：`../README.md` 由新建 `docs/README.md` 修复、`frontend/style.md` 由 `ui.md` 取代、`plan/development.md` 改为开发方案目录） |
| 过时口径残留 | `三栏工作台` / `乙模式` / `甲模式` / `task.assignByAgent` **0 命中**（`deploy.md` 保留一行"已废弃"说明；`.env*` 已删除该键） |
| 会议残留 | 仅 PRD 的编号空缺说明（历史记录，属有意保留） |
| 新术语贯通 | 工具包 32 处、编排图 26 处、询问 39 处、领取 30 处、暂停 31 处、基础包 13 处，跨 PRD/设计/接口/UI/测试一致 |
| 文档地图完整 | `docs/README.md` §1 登记的 22 份文档与实际文件一致 |
| 命名冲突 | 全库无 `AGENTS.md`（避免设计文档被当成目录指令文件） |

## 6. 未做（另需裁决）

- U8 自定义工具包、U9 Agent 配置提交、U10 通用领域场景、U11 第三方/MCP 接入、U12 下游主动沟通；
- 盘点遗留 P0：doc 提交是否审批、产出物面板与回退入口（现统一进右栏列表？未定）、事件规范三套词汇、`config.yaml` 残留、模型 provider id、锁机制术语；
- 原 `docs/plan/development.md`（里程碑与验收列）仍未重建——本次只记录了它应由 `docs/plan/` 承载；
- 代码实现（`src/`、`web/`、`tests/`）。

## 7. 回滚

本次改动分布在 14 个文件（新增 7、修订 11，含 `.env*`）。回滚：`git checkout HEAD -- <path>`（文档改动尚未提交），新增文件直接删除；`.env` 为本地忽略文件，需手工恢复 `TASK__ASSIGN_BY_AGENT`。
