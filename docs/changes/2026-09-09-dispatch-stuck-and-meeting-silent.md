# 2026-09-09 修复「派单后角色不开工」「会议发起后无人发言」

> 类别：changes · 需求来源：用户反馈两条（PM 派单后角色无法开工；角色发起会议后没有向会议发言/商讨）

## 根因（真实数据定位）

导出用户三个项目的数据后确认：

### 问题 1：派单后不开工

- PM 新派的两个任务都是 `todo`（工具回执写着"已排队"），因为 `product_1`/`architect_1` **各自已有一个卡住的 `in_progress` 任务**；
  "每角色至多 1 个进行中"→ 新任务只能排队，而旧任务永远不会完成 → **队列永久堵死**。
- 旧任务为什么卡住？那两轮的模型把 2048 的 completion 预算**全烧在推理上**
  （architect 那轮推理 5607 字，最终没有任何正文/工具调用）→ 角色"什么都没干"、更不会调 `task_update`；
  在"用户不再手点完成/终止"的新规则下，**没有任何机制能释放槽位**。

### 问题 2：会议发起后无人发言

- 会议 `m_mtx39cxjt4jmft` 只有 6 条 `meeting_event`（create/respond/open/lineup），**没有一条 message**。
- 主持人是在自己的 user 会话里调 `meeting_start`，平台既没有让它进会议开场，也没有叫受邀成员发言；
  `meeting_talk`（主持人点名）当时**根本没注册**。

## 修复

### A. 派单不再堵死

- **槽位释放自动接单**（`TaskService.promoteNext`）：任务置 `done`/`terminated` 后，
  自动把该受派者**最旧的 `todo` 任务**置为 `in_progress` 并唤醒（D18-③ 的延伸）。
- **推理预算**：openai-compatible provider 默认 `max_tokens` 2048 → **8192**，
  避免推理型模型"只推理、不出正文/工具调用"。

### B. 会议真正开起来

- 新工具 **`meeting_talk{meetingId, member, question?}`**（仅主持人）：点名某成员发言（其发言写入会议会话）。
- `meeting_start` 之后平台自动开链（后台串行，不阻塞当前回合）：
  **主持人开场 → 依次请每位受邀成员发言 → 主持人收尾**（给出结论/待办/待拍板事项，可 `meeting_close`）。
- 会议内发言回合结束时**保持"会议中"占用**（`m_` 会话的回合结束后重新登记 meeting 占用）。

### C. 顺带修掉一个真实并发缺陷

- 新增的后台会议发言链暴露出：`SessionStore.writeMeta` 没走会话写锁，
  与并发的 `appendEvent` 互相覆盖 —— 实测表现为**会议 `close` 后又被写回 `open`**（测试偶发失败）。
- 现在 `writeMeta` 与 `appendEvent` **共用同一把会话锁**，并取"磁盘与传入的 `lastSeq` 较大者"；
  `appendEvent` 在锁内使用不加锁的内部写，避免自锁。

## 验证

- `npx tsc`、`npx eslint .` 通过；`npx vitest run --pool=threads` **141 用例全绿**（连跑 4 次稳定）。
  新增/更新用例：会议发起后会议会话出现"主持人开场 + 受邀成员发言"；`meeting_talk` 仅主持人可调用；
  槽位释放后排队任务自动接单（`tasks-m8b` 原用例改为断言自动接单）。
- 真实模型冒烟（deepseek-v4-flash）：
  - PM 一次派两单 → 第一单 `in_progress` 且 **dev 被唤醒开工**；第二单 `todo` 排队；
    dev 用 `task_update` 完成第一单后，**第二单自动置 `in_progress` 并再次唤醒 dev**（不再堵死）；
  - dev 发起「接口与验收对齐」会议 → 会议会话出现 `dev_1`（主持人开场）与 `pm_1`（受邀成员）的发言，会议状态 `open`。

## 遗留（说明）

- 后台会议链是**串行**的（主持人开场 → 每位成员 → 收尾），人数多时耗时较长；期间用户可插话/拍板/结束。
- 卡死任务若已无产出，协调者仍可用 `task_update`（甲模式下可改他人任务）置 `blocked`/`terminated` 后重派。
- 会议发言不改变会议状态；纪要仍在 `meeting_close` 时生成。
