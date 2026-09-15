# 修改记录 · S9 全量验收与文档收口

> 类别：changes · 日期：2026-09-15 · 关联方案：[docs/plan/2026-09-15-s9-acceptance-closure.md](../plan/2026-09-15-s9-acceptance-closure.md) · 总计划：[development.md](../plan/development.md) §6
> 关联设计：[prd](../requirements/prd.md) §9、[testing/plan.md](../testing/plan.md)、[contract.md](../api/contract.md)、[data-storage.md](../design/data-storage.md)、[README.md](../README.md)

## 1. 需求 / 问题

S0~S8 主体功能都已实现，但**没有一条可执行的端到端验收**：prd §9 的脚本 1~8 从未被真实跑通（`ask_user` 阻塞、审批拒绝、重启恢复等都只在单点用例里验证）；也没有覆盖率门禁与文档索引收口。本轮把 MVP 推到"按 §9 可验收"，并修掉验收暴露的问题。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| tests | `tests/acceptance/prd-section9.test.ts`、`tests/helpers-scripted-gateway.ts`、`tests/helpers-server.ts` | §9 脚本 1~8 各一个用例；脚本化 Mock 网关（带条件步骤优先）；helper 增 `gateway` 注入、`root` 复用（模拟重启）与 `cleanupRoot` |
| bootstrap | `src/bootstrap/composition-root.ts`、`src/application/dispatcher/dispatcher.ts`、`src/infra/file-store/dispatcher-state-store.ts`、`src/ports/dispatcher.ts` | `resolveDeps({ gateway })` 注入点；调度态 **`update()` 读改写**（修缺陷 1）；删除死代码 `application/agent-loop/placeholder-runner.ts` |
| server | `src/server/http-routes/health.ts` | 落地 `GET /api/config`（运行期只读总览，不含密钥）|
| roles | `src/shared/roles/*.yaml`（8 个内置模板） | 工具白名单补齐基础协作工具（`task_view/list/claim/update`、`memory_append`、`session_search`、`approval_query`、`artifact_rollback`；productive 角色补 `workdir_edit`；pm 保持只协调不产出）|
| tools | `tools/coverage-gate.mjs`、`package.json` | 触达门禁（测试 → 传递 import 图可达性 + 分层统计）；`npm run coverage` |
| docs | `docs/testing/plan.md`、`docs/api/contract.md`、`docs/design/{data-storage,tools}.md`、`docs/README.md`、`docs/plan/development.md` | 规则→用例映射、验收记录、覆盖率口径；`/api/config` 与导出契约；调度态读改写与模板白名单口径；§3.4 阶段编号索引；S9 状态 |
| docs | `docs/plan/2026-09-15-s9-acceptance-closure.md`、`docs/changes/2026-09-15-s9-acceptance-closure.md` | 本阶段方案与记录 |

## 3. 关键决定

1. **验收真跑 agent loop**：新增脚本化 Mock 网关，`resolveDeps` 开放 gateway 注入；委派、通知唤醒、`ask_user` 阻塞、高危命令审批都由**模型发起的 tool-call** 驱动。
2. **并发应答步骤用同源工具处理函数**：`ask_user`/审批需要边跑边答，用例取 `toolRegistry.get(name).handler`（与 loop 同一函数），并在独立容器里验证。
3. **触达门禁替代行覆盖率**（不新增依赖）：`npm run coverage` 检查 141 个源码文件是否被测试路径可达（进程入口白名单 2 个），并按层输出统计。
4. **验收即回归**：发现的 4 个缺陷按最小修复处理并回写设计口径（见 §4），不放宽断言。

## 4. 验证结果

| 验证项 | 结果 |
| --- | --- |
| prd §9 脚本 1~8 | `tests/acceptance/prd-section9.test.ts` **8/8 通过**：①全流程（7 包/8 模板 → 建项目 → 画布 pm→dev、dev→qa 保存 → PM 会话启动 → 沿出边委派 → dev 通知唤醒+task_list → task_claim → workdir_edit+memory_append → 询问答复 → 汇报 done → code 产出物 + 记忆可见 → 重开新容器读同数据根恢复会话/画布/记忆）；②纯 Mock 无 Key；③单工与队列；④安全（高危命令拒绝后文件仍在 + 越界路径 + 他人产出物）；⑤文档交付（含 S0~S9 方案与记录齐备）；⑥编排约束（越边不建任务、画布不变、用户不受限）；⑦控制与询问（停止任务先结算快照；ask_user 阻塞 → `waiting` → 答复续跑）；⑧模型与 Agent 配置（预置/测试连接/默认模型/复制模板/内置只读/实例覆盖生效/引用保护/密钥掩码） |
| 全量测试 | **44 files / 302 tests 全绿** |
| 门禁 | `typecheck` 0 错误；`lint` 0 error；`ratchet` 越层违规 0；`coverage` **141/141 可达**；`build` 成功 |
| 缺陷修复 | ① 调度态读改写（重复处理队列消息）；② 模板工具白名单补齐（真实模型可领取任务）；③ `GET /api/config` 落地；④ 删除死代码 `placeholder-runner.ts` |
| 文档 | `testing/plan.md` §5 规则→用例映射 + §6 验收记录；`contract.md` `/api/config`；`data-storage.md` 调度态读改写；`tools.md` 白名单口径；`README.md` §3.4 阶段索引 |

## 5. 未做 / 回滚

- 未做（P1/P2）：托盘批量审批与信任开关 UI、行覆盖率工具链、导出流式压缩、多进程部署下的停止语义；`prd` §10 的 U8/U9（剩余）/U10~U16。
- 回滚：删除 `tests/acceptance/`、`tools/coverage-gate.mjs`、`tests/helpers-scripted-gateway.ts` 与 `package.json` 的 `coverage` 脚本；还原 `resolveDeps`（去掉 gateway 覆盖）、调度态 `update()`（改回 `save`）、8 个模板的 `tools:` 行、`health.ts` 的 `/api/config`、`docs/README.md` §3.4 与各文档的 S9 段落。
