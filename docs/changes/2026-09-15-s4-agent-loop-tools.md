# 修改记录 · S4 Agent loop 与工具执行（2026-09-15）

> 类别：changes · 类型：**实现** · 方案：[docs/plan/2026-09-15-s4-agent-loop-tools.md](../plan/2026-09-15-s4-agent-loop-tools.md) · 总计划：[development.md](../plan/development.md) §6
> 需求来源：用户"开始全部开发"；本轮落地规则 2（路径边界）、规则 3（高危审批）、规则 11（审批跨重启）、规则 26（暂停中断），以及 FR-04（Agent 单轮执行）、FR-13（工具执行与安全）的底座

## 1. 交付内容

| 层 | 新增/修改文件 |
| --- | --- |
| 端口 | `ports/{tools,path-resolver,policy,approval,sandbox}.ts`；`ports/turn.ts`（+`sessionType`）、`ports/tools.ts`（+`policyAction`）、`ports/tokens.ts`（20 → 23） |
| 领域 | `domain/rules/policy.ts`（命令风险分级 + 统一策略引擎） |
| infra 沙箱 | `infra/sandbox/path-resolver.ts`、`infra/sandbox/cmd-runner.ts` |
| infra 工具 | `infra/tools/registry.ts`、`infra/tools/packages.ts`、`infra/tools/builtin/index.ts` |
| infra 审批 | `infra/file-store/approval-store.ts` |
| application | `application/approval/approval-service.ts`、`application/tools/tool-executor.ts`、`application/agent-loop/{loop,context-builder,strategies,runner,preview}.ts`（占位执行器删除） |
| server | `server/http-routes/{approvals,tools}.ts`、`projects.ts`（system-prompt 预览）、`app.ts`（接入） |
| bootstrap | `composition-root.ts`（沙箱/策略/审批端口 + 审批服务 + 工具注册表 + loop 注册表 + **真实 runner** + 预览服务）、`main.ts`（服务注入） |
| 前端 | `web/src/api/platform.ts`、`web/src/pages/ToolsModule.tsx`；`SessionPanel`（审批卡）、`ProjectModule`（提示词预览）、`App.tsx`（工具模块） |
| 测试 | `tests/unit/domain/policy.test.ts`、`tests/unit/infra/path-resolver.test.ts`、`tests/unit/application/{tool-executor,loop-strategies}.test.ts`、`tests/integration/server/approvals-api.test.ts`；修正 3 条 S3 断言 |

## 2. 关键决定（可推翻）

1. **三策略真实化**：`direct`（≤2 次调用，最多一轮工具）、`reflective`（真 critique + 修订，轮数受 `maxIterations`）、`plan-execute`（**计划由模型产出 JSON 并被消费**，逐步执行 + `plan` 进度事件 + 汇总）。这修正了 `agent-runtime.md` §3 记录的"提示级差异、参数无消费者"现状。
2. **审批真相在文件**：`approvals.jsonl` append-only（同 id 多行、最后一条为准）；决定落盘 + 唤醒进程内等待者；跨重启 pending 保持、决定不回放（规则 11 有集成用例）。
3. **`waiting` 为派生值**：占用 + pending 审批 → 状态投影 `waiting`，不新增持久状态（D18-④ 真相单轨）。
4. **内联代码执行视为高危**（演示实测发现的漏洞）：`node -e`/`python -c`/`bash -c`/`powershell -Command` 可绕过命令风险表 → 统一 `CMD_INLINE_CODE` 走审批。
5. **离线模式同时约束命令与工具**：策略引擎在命令分支先判 `outbound`（`CMD_NET`/安装类/`git push`）→ `NET_OFFLINE` deny；修复了"只判工具分支"的遗漏（单测抓出）。
6. **`policyAction` 不能用 `??` 兜底**：执行器原本写 `definition.policyAction?.(args) ?? default`，导致"返回 null 表示参数非法"永远走不到 → 改为显式分支（单测抓出）。
7. **`resolveForWrite` 只拒绝只读根**：`runtime://`（项目运行时目录）必须可写，原先把它和 `ro://` 一起拒绝了（单测抓出）。
8. **越层修复**：包元数据原放 `shared/tool-packages.ts` 但引用了 ports 类型 → 依赖门禁拦下，移到 `infra/tools/packages.ts`。
9. **S3 断言改为结构性**：不再绑定占位执行器的具体事件序列，改为"回合边界 + seq 连续 + 存在 agent 消息 + loopStep 正确"。

## 3. 验证结果

| 验证项 | 结果 |
| --- | --- |
| 类型检查（服务端 + 前端） | 0 错误 |
| 测试 | **27 files / 184 tests 全通过**（S4 新增 37 条；修正 3 条 S3 断言） |
| 门禁 | `eslint .` exit 0；ratchet 越层违规 0 |
| 真实服务：真实 loop | 事件序列 `#1 message · #2 turn_start · #3 plan · #4 plan · #5 message · #6 turn_end`（plan-execute 真实形态） |
| 系统提示词预览 | blocks = `role-config / platform-role / tools / session-window`（与运行期同源） |
| 规则 2 | `workdir://../outside/secret.txt` → `ERR_FORBIDDEN_PATH`；软链接逃逸 → 同样拒绝 |
| 规则 3 | 审批被拒 → `ERR_APPROVAL_REJECTED` 且命令**未执行**；批准 → 落盘 `pending` 后执行成功；`rm -rf /` → deny；离线 `curl` → `ERR_NET_OFFLINE` |
| 规则 11 | 演示：`approvals.jsonl` append-only（3 行）；集成用例：重启后 pending 仍可见、决定不回放、重复决定 409 |
| 规则 26 | 暂停 → 回合在可中断点结束（游标不推进）；恢复 → 补处理排队消息 |
| 前端 | `vite build` 成功；工具模块（展示态 vs 生效态）、审批卡、提示词预览 |

## 4. 未做 / 遗留

- 记忆 / 会话检索 / 产出物 / 任务 / 询问工具未实现（包已声明，UI 标注"未实现"）；S5/S6 补齐。
- 托盘批量审批与信任开关 UI 未做（策略引擎已支持 `trust` 数据源并有单测）。
- 停止任务（`stop`）与未完成回合恢复三选（D17-⑤）留 S8。
- 命令沙箱仍是逻辑沙箱（无 OS 级隔离），与 design/sandbox.md 口径一致。
- 端口 3000 仍被 14:29 启动的旧实例占用（非本轮），验收统一用 3100。

## 5. 回滚

```bash
git rm src/ports/{tools,path-resolver,policy,approval,sandbox}.ts src/domain/rules/policy.ts \
  src/infra/sandbox/{path-resolver,cmd-runner}.ts src/infra/tools src/infra/file-store/approval-store.ts \
  src/application/approval src/application/tools src/application/agent-loop/{loop,context-builder,strategies,runner,preview}.ts \
  src/server/http-routes/{approvals,tools}.ts web/src/api/platform.ts web/src/pages/ToolsModule.tsx \
  tests/unit/domain/policy.test.ts tests/unit/infra/path-resolver.test.ts \
  tests/unit/application/{tool-executor,loop-strategies}.test.ts tests/integration/server/approvals-api.test.ts
git checkout HEAD -- src/ports/{turn,tools,tokens}.ts src/application/agent-loop/placeholder-runner.ts \
  src/application/dispatcher/dispatcher.ts src/bootstrap/{composition-root,main}.ts src/server/{app.ts,http-routes/projects.ts} \
  tests/helpers-server.ts tests/integration/server/{sessions-api,ws-gateway}.test.ts \
  web/src/App.tsx web/src/pages/{SessionPanel,ProjectModule}.tsx docs/api/contract.md docs/plan/development.md
```
