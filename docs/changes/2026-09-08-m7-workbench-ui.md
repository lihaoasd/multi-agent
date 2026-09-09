# 修改记录 · Agent Haness

> 位置：docs/changes/，按日期追加；遵循项目 skill 的 change-record 约定。

## 2026-09-08 M7 补充：工作台任务面板 / 「需你处理」原地操作 / 项目导出按钮

- 需求/问题: 继续整体开发目标：补齐乙模式 UI 工作流——右栏任务面板（todo→开工 in_progress→完成/终止），顶栏「需你处理」弹窗内**原地**批准审批/会议拍板（D17-③ 待办条第一优先级），项目导出 zip 按钮。
- 类型: 代码(扩展) + 测试(服务端引用字段)
- 改动范围:
  1. `src/application/attention/attention-service.ts`：AttentionItem 增可操作引用（approvalId / meetingId+questionId），供 UI 原地操作。
  2. `web/index.html`：右栏新增「任务」块；顶栏「需你处理」改为按钮并新增弹窗容器；顶栏新增「导出 zip」按钮。
  3. `web/style.css`：弹窗(.modal/.modal-box)、ghost 按钮、task-item 样式。
  4. `web/app.js`：
     - refreshPanels 加载 /tasks 并 renderTasks（按状态给 开工/完成/终止 动作，冲突以服务端 ERR_CONFLICT toast 提示）；
     - openAttentionModal：列出待办项，审批可原地 批准/拒绝、会议拍板可原地答复，操作后刷新列表；
     - 「导出 zip」跳转 /api/projects/:pid/export。
  5. 测试：attention-m8d 已覆盖 kind/引用字段的服务端契约（本轮 UI 无自动化，parse 检查 + 冒烟验证）。
- 原因: 让用户经 UI（非手敲 API）完成「指派任务→开工→完成/终止、审批、拍板、导出」——M7 演示闭环收口。
- 行为变化: UI 可创建后对任务置位（遵守 D17-① 每 Agent 1 in_progress 与 done/terminated 仅 user）；待办条弹窗原地处理审批/拍板；一键导出项目 zip。
- 验证: `npm run test` 105/105；tsc/eslint 0 错；build 0 错；冒烟 3105：GET / 含 btn-export/attention-modal，/app.js 含 renderTasks。
- 测试: attention-m8d（服务端）；UI 语法 `node --check` 通过。
- 遗留(说明): 任务创建 UI（当前经 REST/接口创建，面板仅流转）、待办弹窗更多选项输入（拍板自定义文本）为前端后续；前端无自动化测试框架（Playwright P1）。
