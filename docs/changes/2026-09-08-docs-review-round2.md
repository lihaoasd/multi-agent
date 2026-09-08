# 修改记录 · Agent Haness

> 位置：docs/changes/，按日期追加；遵循项目 skill 的 change-record 约定。

## 2026-09-08 文档评审轮 2：架构师审核问题闭环（A1~A6 定案 + B1~B12 修正）

- 需求/问题: 全套文档第二轮架构审核发现：1 处会议状态机闭合性缺口、3 处行为语义矛盾（suspended/plan 续跑/审批卡措辞）与若干"会咬到实现"的细节未定义；经与用户逐条问答定案（全部采纳推荐方案）。
- 类型: 文档(变更/定稿)
- 决策（新增，见 prd §7 D16；B 类为口径修正不入决策表）:
  - D16-① 会议状态与排队持久化：会议会话发起即创建并全量落盘；`queued(排队,不占槽)→proposed(邀请征询,占槽)→open⇄blocked_waiting_user→closed`；征询期主持人可回 user 会话，≥1 成员接受转 open；queued 槽空自动转 proposed、重启可恢复。
  - D16-② suspended 收敛：会话级 suspended 保留并落盘（user 会话被会议占用/重启恢复期）；Agent 级状态收敛为 idle/working/meeting/waiting 四态（移除 suspended），P1 hangup 再引入。
  - D16-③ plan-execute 回合语义：单回合多步长跑（turn_end 在汇报/产出时写入）；回合内暂停仅审批（waiting）与会议抢占（可中断点），由 dispatcher 同一会话续跑（plan 事件依据）；用户普通消息只入队不打断；跨重启不自动续跑（缺 turn_end=未完成，用户下条消息触发汇报/续做）。
  - D16-④ 任务激活规则：每 Agent 至多 1 个 in_progress（置新自动回退旧的并 UI 提示）；仅 in_progress 注入上下文并作代码聚合锚点（todo/口头指派按回合兜底）；纪要转任务 creator=user、来源挂会议（Agent 直建仅甲模式）。
  - D16-⑤ 角色模板快照：实例创建时快照模板默认值（prompt/tools/审批），此后模板增删改不影响既有实例；删除被引用模板仅 UI 标「模板已移除」；取消"同名文件覆盖内置"说法，改 UI「基于内置复制新建」。
  - D16-⑥ doc 审批预览：doc 类提交命中审批时生成只读预览（文本=内容；二进制/设计稿=文件信息）随审批卡提供并落审批记录 previewRef，不开放私有区整体浏览。
  - B 类口径（不新增决策，仅统一文档）：code artifact 初始 state=approved（B1）；审批 kind 增 rollback（B2）；拒绝原因"建议填、可选"（B3）；工具元数据增 allowedRoots（B4）；continue/补全以 turnId 锚定、重启后半截文本丢失语义（B5）；忙碌实例停用边界与删除项目校验（B6）；会议排队落盘并入 D16-①（B7）；model 字段=provider id 口径（B8）；类型→审批门映射（B9）；纪要转任务 creator=user 并入 D16-④（B10）；右栏记忆 Tab 树补全（B11）；模板复制新建路径（B12）。
- 改动范围（关键文件）:
  - prd.md：§7 新增 D16 行；docs/README.md：术语表 Agent 状态四态化、决策行 D1~D16。
  - agent-runtime.md：状态图四态化/两级状态映射/停用边界；长任务注改 D16-③ 回合语义；任务上下文补激活规则；模型路由补 provider id 口径。
  - sessions.md：§2 生命周期与状态机按类型分列（user: active/suspended/archived；meeting: queued/proposed/open/blocked_waiting_user/closed）。
  - meetings.md：生命周期/槽位（proposed 起占槽、queued 排队自动转）、征询期主持人回 user 会话、纪要转任务 creator=user。
  - data-storage.md：meta.state 按类型分列注释；project.json 注释（模板快照/provider id/类型→门）；approval kind+previewRef；code artifact 初始 approved；任务激活规则注释；§8 模板只读+复制新建。
  - memory.md：§6 恢复表（服务退出含 queued/proposed、plan 断点不自动续跑、长会议全状态、补全语义）。
  - workspaces-artifacts.md：doc 审批只读预览步骤；任务聚合激活规则与 code 初始 approved；§6 类型→门映射。
  - architecture.md：§5.1 plan-execute 单回合语义尾注；§7 一致性表增停用忙碌实例/删除项目两行。
  - tools.md：注册表元数据增 allowedRoots；可用根说明（fs_*=workdir+ro、ws_*=ws-self）；模板快照措辞。
  - contract.md：roles 内置只读复制新建、meetings POST 返回 proposed|queued、continue 端点语义（turnId 锚定）。
  - frontend/style.md：右栏 Tab 树补记忆；会议会话列表状态文案；任务单 in_progress 提示；审批卡只读预览；拒绝原因措辞；角色库复制新建。
  - testing/plan.md：规则 16~19（会议状态持久化/plan 回合语义/任务激活/模板快照与审批预览）。
- 行为变化: 无（纯文档阶段）。文档口径变更：会议排队/征询持久化；Agent 级 suspended 移除；plan-execute 不自动续跑；任务单激活；模板创建时快照；doc 审批带只读预览；工具元数据含 allowedRoots。
- 验证: 逐条与 D16 对应；全文 grep 校验无残留旧表述（Agent 级 suspended 状态集、"null = 用模板"、"同名文件覆盖内置"、会议状态与 meta 枚举不一致、"非强制"矛盾句等）；决策编号 D16 引用一致；未决清单仍仅 U1/U5。
- 测试: 无（文档阶段）。
