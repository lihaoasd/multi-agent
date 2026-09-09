# 修改记录 · Agent Haness

> 位置：docs/changes/，按日期追加；遵循项目 skill 的 change-record 约定。

## 2026-09-08 M6/M7 补充：会议轮次引擎 MVP（点名发言 / 插话 / 纪要重生成）

- 需求/问题: 继续整体开发目标：补齐会议轮次引擎 MVP（meetings.md §4）——主持人点名成员发言（成员在会议会话执行一轮 Agent 回合）、用户插话（open/blocked 均可）、纪要「重新生成」（D18-⑤b 可重放派生视图）。
- 类型: 代码(扩展) + 测试
- 改动范围:
  1. `src/application/session/session-service.ts`：新增 `runAgentTurn(projectId, sessionId, instanceId, {prompt?})`——在任意会话（含 meeting）为参会成员执行一轮：点名问题落盘为会议可见 user 消息（日志真相源），随后经同一实例的 FIFO 队列串行跑 direct 回合（单工）；抽出 `enqueue()` 供 user 消息发送与点名发言复用。
  2. `src/application/meeting/meeting-service.ts`：
     - `speakTurn`：主持人点名成员发言（非主持人 403、非 open 409、成员校验）；轮次前落 `meeting_event{action:'round'}`；问题缺省自动取 pending 议程。
     - `userInterject`：open/blocked_waiting_user 均可插话，写入 message(user) + interject 标记。
     - `regenerateMinutes`：closed 后可重放生成（幂等，UI「重新生成纪要」落点）。
  3. `src/application/composition.ts`：向 MeetingService 注入 runMemberTurn=sessionService.runAgentTurn；`src/server/app.ts` REST：POST /meetings/:mid/talk、/messages、/regenerate-minutes。
  4. `tests/meeting-round-m6b.test.ts`：3 用例（点名发言后 dev 在会议会话出现 agent message+turn_end；非主持人 403/blocked 409；插话入日志+close 后重生成成功+未结束 409）。
- 原因: 让"会议异步轮次推进"从用户纯手工驱动（发起→接受→拍板→结束）扩展到"主持人点名、成员发言、用户插话、纪要可重放"。
- 行为变化: 主持人可点名成员在会议内发言（Mock 直答，消息流入会议日志并经 WS 推送）；用户可随时在会议内插话；closed 会议纪要可随时重新生成。
- 验证: `npm run test` 100/100；tsc 0 错；eslint 0 错。
- 测试: meeting-round-m6b 3 用例。
- 遗留(说明): 成员「自主入会剧本（先完成当前回合再入会）」「插话被主持人纳入议程的仲裁」「超时跳过」「meeting_advance 工具（真实模型工具链）」「讨论串分组 UI」仍留后续；跨重启排队会议占槽自动转 proposed 语义依赖 dispatcher 队列持久化（runtime occupancy 已具雏形）。
