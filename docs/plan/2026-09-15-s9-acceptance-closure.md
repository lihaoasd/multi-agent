# 开发方案 · S9 全量验收与文档收口

> 类别：plan · 状态：已完成（2026-09-15）· 类型：**验收与收口** · 总计划：[development.md](development.md) §6 · 执行结果见 [修改记录](../changes/2026-09-15-s9-acceptance-closure.md)
> 关联：[prd.md](../requirements/prd.md) §9、[testing/plan.md](../testing/plan.md)、[contract.md](../api/contract.md)、[data-storage.md](../design/data-storage.md)、[README.md](../README.md)

## 1. 目标与范围

把 MVP 从"各阶段都实现"推到"**按 prd §9 脚本 1~8 全量可验收、文档与实现一致**"：可执行的验收套件、覆盖率（触达）门禁、契约与存储回写、README 编号索引同步，以及验收过程中发现的真实缺陷修复。

| 在范围内 | 不在范围内（P1/P2） |
| --- | --- |
| `tests/acceptance/prd-section9.test.ts`：§9 条目 1~8 各一个可执行用例 | 浏览器端手工验收（由用户按 §9 脚本 1 走一遍 UI） |
| 脚本化 Mock 网关（`tests/helpers-scripted-gateway.ts`）：让验收真的经过 agent loop | 真实供应商联网验收（需用户密钥） |
| 触达门禁 `npm run coverage`（文件级可达性 + 分层统计） | 行覆盖率工具链（`@vitest/coverage-v8`，需新增依赖） |
| 契约/存储/测试计划/README 的最终回写 | U8/U9 剩余/U10~U16 未决项 |
| 验收暴露缺陷的修复（调度态读改写、模板工具白名单、`GET /api/config`、死代码清理） | 托盘批量审批与信任开关 UI |

## 2. 关键决定

1. **验收必须真跑 agent loop**：默认 Mock 适配器只回声、不产生 `tool-call`，因此新增**脚本化 Mock 网关**（带条件的步骤优先于无条件兜底），并把 `resolveDeps({ gateway })` 打开为测试注入点；验收里"PM 沿出边委派 / dev 被通知唤醒 / ask_user 阻塞 / 高危命令审批"都由**模型发起的工具调用**驱动。
2. **需要并发应答的步骤用同一套工具处理函数**：`ask_user` 与高危命令审批要在回合运行中从外部应答，用例直接取 `toolRegistry.get(name).handler`（与 loop 调用的完全同一函数），并在隔离的新容器里验证（互不干扰）。
3. **触达门禁替代行覆盖率**：不引入新依赖，改用"测试 → 传递 import 图可达性"+分层统计；进程入口（`bootstrap/main.ts`、`bootstrap/reindex.ts`）白名单化。门禁同时揪出并删除了一段**死代码**（S3 的 `placeholder-runner.ts`，S4 已被真实 runner 替换）。
4. **验收即回归**：验收过程中发现的缺陷按"最小修复 + 回写设计口径"处理（见 §4），不掩盖、不放宽断言。
5. **README 编号索引同步**：新增 §3.4 阶段编号索引（`S0`~`S9` → 方案/记录链接）与术语补充，使文档体系入口与 10 个阶段的留痕一一对应。

## 3. 交付物

| 步骤 | 交付物 |
| --- | --- |
| S9.1 验收套件 | `tests/acceptance/prd-section9.test.ts`（8 个用例 ↔ §9 条目 1~8） |
| S9.2 测试装配 | `tests/helpers-scripted-gateway.ts`（脚本化网关）、`tests/helpers-server.ts`（`gateway` 注入、`root` 复用模拟重启、`cleanupRoot`）|
| S9.3 注入点 | `composition-root.ts` 的 `resolveDeps({ gateway })` |
| S9.4 门禁 | `tools/coverage-gate.mjs` + `npm run coverage` |
| S9.5 缺陷修复 | 调度态**读改写**（`DispatcherStateStore.update`）、8 个内置模板工具白名单补齐、`GET /api/config` 落地、删除死代码 |
| S9.6 文档收口 | `contract.md`（`/api/config` + 验收口径）、`data-storage.md`（调度态读改写）、`tools.md`（模板白名单）、`testing/plan.md`（§5 规则→用例映射、§6 验收记录、覆盖率口径）、`README.md`（§3.4 阶段索引）、本方案与 changes 记录 |

## 4. 验收方式与结果

| 验证项 | 方式 | 结果 |
| --- | --- | --- |
| prd §9 脚本 1~8 | `npx vitest run tests/acceptance/prd-section9.test.ts` | **8/8 通过**（详见 [记录](../changes/2026-09-15-s9-acceptance-closure.md)） |
| 全量测试 | `npm run test` | **44 files / 302 tests 全绿** |
| 门禁 | `typecheck` / `lint` / `ratchet` / `coverage` / `build` | 0 错误 / 0 error / 越层违规 0 / 141 个源码文件全部可达 / vite 构建成功 |
| 契约回写 | `contract.md` | `/api/config`、运行控制与恢复、编排图、导出、记忆检索等均已按实现回写 |
| 存储回写 | `data-storage.md` | 调度态读改写、未完成回合标记、导出、记忆/产出物/任务/询问 append-only 口径均已登记 |
| 文档索引 | `README.md` §3.4 | `S0`~`S9` 阶段 → 方案/记录链接齐备 |

## 5. 验收中发现并修复的缺陷

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | 委派通知唤醒受派人后，**同一条队列消息会被重复处理**（状态里 `queued` 不归零） | 回合内嵌套为其它 Agent 触发 `drain`，外层用**陈旧快照整份覆盖** `runtime.state.json`，丢掉内层刚写入的游标 | `DispatcherStateStore` 增 `update(projectId, mutate)`（同锁内读改写），dispatcher 的占用/游标/暂停/清理全部改走它 |
| 2 | 内置模板白名单缺 `task_claim`/`task_list`/`task_view`/`memory_append`/`session_search`/`approval_query`，**真实模型无法领取任务**（脚本 1 的闭环会断） | 模板 `tools:` 未覆盖 D19-② 的基础协作工具 | 8 个模板补齐基础协作工具（dev/ops/qa 另含 `workdir_edit`/`cmd_run`，productive 角色按 2026-09-12 决定也获得 `workdir_edit`，pm 仍只协调不产出） |
| 3 | `GET /api/config` 契约有、实现无（404） | S1 把模型部分迁出后漏了"运行期只读总览" | 在 `health.ts` 落地只读总览（不含密钥） |
| 4 | 死代码 `application/agent-loop/placeholder-runner.ts` 仍留在仓库 | S4 用真实 runner 替换后未删 | 删除（并纳入可达门禁的范围） |

## 6. 未做与遗留（P1/P2，已登记于 `prd` §10 与各设计文档）

- 托盘批量同意/拒绝与信任开关 UI（D17-④）、`config/deploy` 逐条审批的差异化（规则 18）。
- 未决项：`U8` 自定义工具包、`U9` 剩余（工具挂载编辑与配置回滚）、`U10` 通用场景、`U11` 外部工具、`U12` 反向沟通、`U13` 用量统计、`U14` 密钥加密、`U15` 配置回滚、`U16` 代理。
- 行覆盖率工具链（当前为文件级触达门禁）、导出的流式压缩、多进程部署下的停止语义。
