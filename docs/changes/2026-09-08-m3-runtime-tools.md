# 修改记录 · Agent Haness

> 位置：docs/changes/，按日期追加；遵循项目 skill 的 change-record 约定。

## 2026-09-08 M3 Agent 运行时与工具（dispatcher occupancy + PolicyEngine + 工具执行器 + 审批桥）

- 需求/问题: 完成 M3 里程碑：dispatcher 单工占用(occupancy)、loop 策略(direct/reflective/plan-execute 的提示级差异注册)、工具注册表+路径边界、cmd_run 白名单+高危审批、审批队列与落盘。用户已解除逐阶段确认，自主推进。
- 类型: 代码(新建) + 测试
- 改动范围:
  1. `src/domain/rules/command-policy.ts`：PolicyEngine 命令侧判定纯函数（deny>approval>allow；只读/构建 allow、rm -rf/git push/npm publish/卸载 approval、curl|sh/sudo 类 deny、offline 网络 deny、未知程序 approval）。
  2. `src/domain/rules/path-resolver.ts`：虚拟路径 L0 边界（ws://workdir://ro://runtime:// 映射+contain 校验；绝对路径/../逃逸/未知格式一律越界 ERR_FORBIDDEN_PATH）。
  3. `src/infra/tools/executor.ts`：工具注册表+执行器。内置 fs_read_file/fs_list_dir(workdir+ro)、ws_write/ws_read(本人私有区，D14-⑩ 可用根收窄)、cmd_run(结构化 argv、cwd 恒 workdir、shell=false、超时；approvalBypass 供审批后放行)；`setCommandRunner` 测试注入；meeting 会话禁产出/执行类。
  4. `src/application/approval/approval-service.ts`：approvals.jsonl 落盘（业务记录先行、决定只落盘不回放，D18-⑤a/agent-runtime §7）；request/decide/list；审计投影追加到会话 log；冲突重复处理 ERR_CONFLICT。
  5. `src/application/tools/tool-coordinator.ts`：审批桥 requestCommand/resumeCommand（进程内批准=按 detail 原命令续跑）。
  6. `src/application/dispatcher/occupancy-store.ts`：runtime.state.json 的 occupancy（D18-④ 单工唯一真相；acquire/release/get）。
  7. `src/application/agent-loop/loop-runner.ts`：回合期 acquire(working)/release(idle) + bus agent.state；systemPrompt 按实例 loop.strategy 注入执行模式提示（direct/reflective/plan-execute 的 MVP 提示级差异，真实多步执行留 M8 真实模型验证）。
  8. `src/application/composition.ts`：注入 approvals/tools/occupancy；新增 composeToolEnv（由项目/团队/配置组路径根与策略）。
  9. `src/server/app.ts`：/api/projects/:pid/approvals GET(状态过滤) 与 /:apid/decide POST（批准命令自动续跑并回传 resumed）。
  10. `tests/tools-m3.test.ts`：14 用例（命令判定矩阵、路径边界、fs/ws 工具与可用根收窄、meeting 会话限制、fake runner 执行、审批 pending→approve→resume 执行 / reject 不执行、审批落盘）。
- 原因: M3 打通"工具是 Agent 唯一受控通道 + 边界 + 审批"，为 M4 提交制提供执行底座。
- 行为变化: 会话回合期间 Agent occupancy 落盘并可查询；高危命令/未知程序默认进审批卡；用户 approve 后原命令续跑，reject 不执行；approvals.jsonl 与会话 log 双写留审计。
- 验证: `npm run test` 72/72；tsc 0 错；eslint 0 错。
- 测试: tools-m3 14 用例覆盖上述。
- 遗留(说明): cmd_run 真实执行依赖 child_process，本沙箱禁止 spawn 故测试用注入 fake runner；用户本机不受限。loop 的 reflective/plan-execute 多步执行(自查/计划步骤)以真实模型接入(M8)为准，MVP 以提示级差异+direct 流式实现。
