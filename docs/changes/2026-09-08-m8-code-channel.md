# 修改记录 · Agent Haness

> 位置：docs/changes/，按日期追加；遵循项目 skill 的 change-record 约定。

## 2026-09-08 M8 补充：code 受控编辑通道（workdir_edit + D14-⑧ 任务级聚合结算）

- 需求/问题: 继续整体开发目标：实现 README「已知边界」首项——code 受控编辑通道（写工作目录通道①）：`workdir_edit` 声明式单文件编辑 + 编辑轨迹 + 任务 done/terminated 时结算为 code artifact（D14-⑧/D17-① 先结算再置终态）。
- 类型: 代码(新建) + 测试
- 改动范围:
  1. `src/application/code-edit/code-edit-store.ts`：编辑轨迹 runtime/<pid>/code-edits/<aggKey>.jsonl（aggKey=taskId 或 untracked_<iid> 兜底）；append/readAll/listRelPaths/clear。
  2. `src/application/tools/service-tools.ts`：注册 `workdir_edit` 工具（user 会话、workdir:// 内；write/replace 声明式编辑；replace 目标不存在 → ERR_CONFLICT（防外部改动覆盖）；meeting 会话拒绝；自动建父目录；每次调用记录轨迹并归属 taskId）。
  3. `src/application/artifact/artifact-service.ts`：`settleCodeAggregation`——读取任务轨迹 relPath 清单 → 快照 workdir 当前内容到 versionDir → 生成 type=code、初始 approved（B1/code 门默认无审批）、带 taskId 的 manifest 记录 → 清空轨迹。
  4. `src/application/composition.ts`：注入 codeEdits 并注册工具；TaskService 增加 settle 钩子：done/terminated 前置结算（D17-① 先结算未结算改动再置终态），成功后 linkArtifact 挂到任务。
  5. `tests/code-channel-m8c.test.ts`：4 用例（写+替换+conflict+越界拒绝 → done 结算 code artifact v1 且 workdir 内容为替换后、轨迹清除；terminated 同样先结算；无 taskId 编辑按 untracked_<iid> 兜底不产生 artifact；meeting 会话拒绝）。
- 原因: 打通"Agent 在真仓库受控编辑 + 全量留痕 + 任务级聚合产物（可回退）"——workspaces-artifacts.md §2.2 的 code 主路径。
- 行为变化: Agent 可在 workdir 内受控编辑源码；任务完成/终止时自动结算为 code artifact（快照+manifest），任务与产物互相挂链；无任务编辑按回合兜底留轨迹。
- 验证: `npm run test` 97/97；tsc 0 错；eslint 0 错。
- 测试: code-channel-m8c 4 用例。
- 遗留(说明): 跨 Agent 文件编辑锁（M5 定稿 ERR_CONFLICT）与批量/覆盖写 high 审批、git 仓库场景提示为后续；回退 code 版本依赖 versionDir 快照已具备（同 doc 路径），git 集成不做。
