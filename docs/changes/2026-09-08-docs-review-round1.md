# 修改记录 · Agent Haness

> 位置：docs/changes/，按日期追加；遵循项目 skill 的 change-record 约定。

## 2026-09-08 文档评审轮 1：架构师审核问题闭环（H1~H6 + M1~M14）

- 需求/问题: 全套文档架构审核发现 6 个高优问题（H1 任务工具缺位/H2 回退缺内容依据/H3 事件模型缺 turn 边界/H4 会议工具可用性矛盾/H5 会议读取边界矛盾/H6 未决与正文不一致）与约 12 项细节缺口（M1~M14）；经与用户逐条确认定案。
- 类型: 文档(变更/定稿)
- 决策（新增，见 prd §7 D14/D15，§10 清理）:
  - D14-1 默认团队=全勾 8 内置模板；D14-2 产出按类型子目录默认布局（U4 定案）；
  - D14-3 MVP 同角色多实例**不支持**（后续迭代，U6 定案）；
  - D14-4 UI 提供原始事件时间线查看（U7 定案，反转原"仅检索+摘要"建议）；
  - D14-5 会议邀请由成员 Agent **自主决定**（暂停→入会→散会后回原工作并自主调整，用户可干预）；
  - D14-6 MVP 同一项目同一时刻至多 1 个进行中会议；
  - D14-7 流式回复以最终落盘消息为准（半截为临时态，"未完成"+补全/重说）；
  - D14-8 代码受控编辑以**任务为单位**聚合 artifact（无任务按回合兜底，Q5）；
  - D14-9 实例移除=**停用保留全部数据**（会话归档只读、可重新启用；彻底删除为后续版本）；
  - D14-10 会议内 fs 读 workdir+ro://、本人私有区经 ws_read 可读，一切写入禁；
  - D15 PM 定位（乙默认 + 甲可选）：MVP 任务由用户 UI 创建/流转，PM 不直接建任务（协调信息落会话/全局记忆）；task_* 工具组已实现但默认关闭（config `task.assignByAgent=false`），开启即甲模式用于 A/B 对比。
- 改动范围:
  - prd.md：§3 PM 职责、US-3/US-11、FR-08、D1 注释、新增 D14/D15、§10 清理（保留 U1/U5）。
  - README.md、docs/README.md：PM 口径、D1~D15、未决 U1/U5。
  - architecture.md：领域模型实例约束（enabled/单实例）、plan 事件续跑、审批跨重启一致性行。
  - data-storage.md：project.json team 增 enabled；事件 kind 增 turn_start/turn_end/plan；summary 事件字段收敛（summaryId/ofSeq/toSeq/digest）并同步 meta summaryRefs/segments；流式/回合边界说明；artifact-versions 版本内容存储（H2 依据）；任务 creator 与状态流转注释（D15）；审批跨重启注释；轮转 seq 跨文件单调+segments；换机重设 workdir 校验（M14a）。
  - agent-runtime.md：MVP 单实例+停用语义；两级状态映射（废弃会话级 waiting_user）；回合事件/流式语义/plan 事件；contextLimits 默认值表（M11）+任务上下文；工具概要表 fs/ws/meeting 边界修正；task_* 默认关闭说明（D15）；审批等待跨重启语义（M1）。
  - sessions.md：meeting 数量约束改 MVP 单会议；状态机重写（移除 waiting_user，增 archived）；停用归档。
  - meetings.md：自主入会（D14-⑤）、散会后恢复与自主调整、MVP 单会议排队（D14-⑥）、工具降级清单按 D14-⑩/H4 重写。
  - memory.md：L1 规则更新（流式临时态/时间线视图/turn 边界）、summary 字段收敛、中断恢复表重写（turn_end 判定/审批跨重启/plan 断点）。
  - workspaces-artifacts.md：产出类型含 design 二进制说明（M14c）、提交快照落盘、版本=提交记录语义（H2）、任务级聚合触发与跨回合累计（D14-⑧）、回退内容依据+前置校验、跨 Agent 编辑锁 ERR_CONFLICT（M5）、产出物状态机补 rejected 转移。
  - tools.md：task_* 工具组（D15 默认关闭）；fs_*/ws_read 根集与会议可用性（D14-⑩）；meeting_advance/close 主持人-in-meeting 可用性（H4）；角色矩阵新增任务行；说明补充。
  - sandbox.md：工具级可用根（L0 是底线非放权）；密钥类命令 MVP 不自动执行（M14b）；并发行指向编辑锁；审批跨重启（M1）。
  - frontend/style.md：向导默认 8 角色；左栏停用/启用与会话只读；中栏对话/时间线切换；右栏新增记忆 Tab（M13）+任务状态默认用户驱动；会议界面自主入会/排队/召离。
  - api/contract.md：fs/browse 用户级全盘浏览（M8）；team DELETE=停用；log 端点支持 kind 时间线；新增 memories 端点（M13）；WS 事件补 team.updated/task.updated；错误码表+内部简码映射（M9）+ERR_MEETING_FULL 等。
  - operations/deploy.md：config 键对齐（docSubmitApproval/codeSubmitApproval，M9）、sandbox.network、task.assignByAgent、context 默认值。
  - plan/development.md：M2/M4 里程碑口径（回合事件/versionDir/任务级聚合）；风险表会议并发行对齐 D14-⑥。
  - testing/plan.md：新增规则 9~15（单实例停用/事件模型/回退内容/审批跨重启/任务聚合/自主入会/时间线）。
- 行为变化: 无（纯文档阶段）。文档口径变更：waiting_user 会话状态废弃；实例删除=停用；会议并发=单会议；任务默认用户驱动（PM 工具通道关闭）；回退/日志/时间线语义补充明确。
- 验证: grep 校验无旧术语残留（waiting_user/“可多个并存”/“回合/任务边界自动聚合”/“受限根”/D1~D13 引用等）；决策编号 D14/D15 与 §10 引用一致；未决清单仅剩 U1/U5。
- 测试: 无。
