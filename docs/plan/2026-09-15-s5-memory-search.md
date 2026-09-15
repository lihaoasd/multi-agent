# 开发方案 · S5 记忆与检索

> 类别：plan · 状态：已完成（2026-09-15）· 类型：**实现** · 总计划：[development.md](development.md) §6 · 执行结果见 [修改记录](../changes/2026-09-15-s5-memory-search.md)
> 关联：[memory.md](../design/memory.md)、[data-storage.md](../design/data-storage.md) §5/§10、[agent-runtime.md](../design/agent-runtime.md) §4、[contract.md](../api/contract.md)、[abstraction.md](../design/abstraction.md) §4.1

## 1. 目标与范围

补齐三层记忆里的 **L2 滚动摘要** 与 **L3 长期条目**，以及**关键词检索**（倒排索引 + 中文 2-gram）：让 Agent 能"记得住"（跨会话的全局/角色记忆）并"找得到"（会话内/项目内检索），同时把记忆与检索片段接进上下文组装。

| 在范围内 | 不在范围内（后续阶段） |
| --- | --- |
| `ports/{memory,search}.ts` + `domain/rules/visibility.ts`（可见性纯函数，D18-②） | 向量/语义检索（`SearchProvider` 扩展点，P2） |
| `infra/file-store/memory-store.ts`（`memories/global.jsonl` + `<instanceId>.jsonl`，append-only + 状态行） | 记忆「钉住/删除」UI（P1，FR-19） |
| `infra/indexer/keyword-index.ts`（token → 引用键倒排，`search-index/index.json` 可重建投影） | 会话归档后写"会话总摘要条目"（归档流程属 S6/S8） |
| `application/memory/{memory-service,summary-engine}.ts`、`application/search/search-service.ts` | 产出物/文件内容的索引（workspaces-artifacts，S6） |
| 三个工具真实形态：`memory_append`/`memory_search`/`session_search` | `resume_context` 恢复工具（S8） |
| 上下文注入 `global-memory`/`role-memory`/`retrieval` 三块（与预览同源） | 任务上下文 `task-context`、产出物索引 `artifact-index`（S6） |
| `npm run reindex` 真实实现 + `GET/POST` 记忆与检索接口 | 索引增量订阅事件总线（MVP 用"查询前同步"） |

## 2. 关键决定

1. **记忆文件按"条目行"append-only**：`global.jsonl` 与 `<instanceId>.jsonl` 各一行一条目；`supersede` 不原地改，而是**追加一条同 id、新状态的行**，读取时同 id 取最后一条（与 `approvals.jsonl` 同构）。好处：崩溃不产生半更新，且历史可审计。
2. **全局记忆写入白名单**：`GLOBAL_MEMORY_TYPES = ['decision','requirement','progress']`（memory.md §4）。`memory_append` 工具**只能写自己角色**的记忆；全局写入只能走应用服务的 `recordGlobal`（引擎/用户确认路径），越权返回 `ERR_FORBIDDEN`。
3. **摘要引擎是"可重放派生视图"**：`summary` 事件落在会话 log 里，`ofSeq/toSeq` **连续无重叠**（下一条摘要的 `ofSeq` 必须大于上一条 `toSeq`；本实现取"上一条之后的第一条消息 seq"）。重跑 `maintain` 只会覆盖**尚未摘要**的新窗口，不重复摘要（幂等）。
4. **触发阈值**：累计 `DEFAULT_SUMMARY_TRIGGER_MESSAGES = 40` 条未摘要的 `message` 事件（memory.md §3.1 的"~40 条"），不足则直接返回 `{summarized:false}`（**不调模型**，绝大多数回合零成本）。摘要用该实例的有效模型一次调用，JSON 解析失败则退化为纯文本 `digest.text`。
5. **摘要同时落一条 L3「progress」条目**（memory.md §4："Agent 显式写入 + **引擎自动提取**"）：写入该角色记忆，`source={sessionId,toSeq}` 可追溯。不做"决策/需求"类的自动识别（避免误判污染，留 S6 用户确认路径）。
6. **检索可见性 = 读取可见性**（D18-②）：`domain/rules/visibility.ts` 纯函数同时被 `session_search`/`memory_search` 与 HTTP 检索接口使用。Agent 可见 = 本人 user 会话 ∪ 项目全局记忆 ∪ 本人角色记忆；用户不受限。
7. **索引是派生投影**：`search-index/index.json` 损坏/缺失不影响业务，查询前 `sync()`：按会话 `lastSeq` 增量读新事件补索引、按条目 id 去重补记忆。`rebuild()` 清空重扫；`npm run reindex` 遍历全部项目重建。
8. **中文分词零依赖**：汉字连续段取 **2-gram**（单字段回退单字），ASCII 词取小写整词；标点/空白/换行即边界。查询侧同样分词，命中按"命中词元数 / 查询词元数"打分，全命中优先，其次按时间倒序。
9. **上下文块顺序对齐 agent-runtime §4**：`role-config → platform-role → global-memory → role-memory → session-window → retrieval? → tools`（原实现把 `tools` 放在 `session-window` 之前，本轮按设计口径修正；`retrieval` 仅在检索到片段时出现）。

## 3. 交付物

| 步骤 | 交付物 |
| --- | --- |
| S5.1 端口 | `ports/memory.ts`、`ports/search.ts`；`ports/tokens.ts` 23 → 25（`MemoryStore`/`SearchIndex`） |
| S5.2 纯函数 | `shared/text.ts`（分词/归一化/词元提取）、`domain/rules/visibility.ts`（可见性判定） |
| S5.3 infra 存储 | `infra/file-store/memory-store.ts` |
| S5.4 infra 索引 | `infra/indexer/keyword-index.ts`（倒排 + 持久化 + 增量 sync） |
| S5.5 application | `application/memory/{memory-service,summary-engine}.ts`、`application/search/search-service.ts` |
| S5.6 工具 | `infra/tools/builtin/memory.ts`（`memory_append`/`memory_search`/`session_search`），`builtin/index.ts` 汇总注册 |
| S5.7 上下文 | `context-builder.ts` 增记忆/检索块与顺序修正；`runner.ts` 注入记忆 + 检索片段 + 回合末维护摘要；`preview.ts` 同源注入 |
| S5.8 server | `http-routes/memory.ts`（列表）、`http-routes/search.ts`（检索 + 重建）、`app.ts` 接入、`contract.md` 回写 |
| S5.9 装配 | `composition-root.ts` 注册端口与服务，工具注册注入记忆/检索回调 |
| S5.10 CLI | `bootstrap/reindex.ts` 真实实现（`npm run reindex [--project <id>]`） |
| S5.11 前端 | `api/memory.ts`、`ProjectModule` 增「记忆与检索」页签（列表 + 搜索 + 跳转） |
| S5.12 测试 | 分词/可见性/记忆存储/索引/记忆服务/摘要引擎/工具 + 集成（记忆 API、检索 API、时间线 kind 过滤） |

## 4. 验证方式与结果

| 验证项 | 方式 | 结果 |
| --- | --- | --- |
| 类型检查 / 门禁 | `npm run typecheck`、`npm run lint`、`npm run ratchet`、`npm run build` | 0 错误 / exit 0 / 越层违规 0 / vite 构建成功 |
| 测试 | `npm run test` | **34 files / 231 tests 全通过**（S5 新增 7 文件 47 条） |
| 规则 6 记忆 | 真实组合根演示 + 集成用例 | 角色/全局条目写入成功；白名单外 `fact` → `ERR_FORBIDDEN`；`GET /memories` 过滤可用、非法 type → 400；`supersede` 保留原行并置状态；摘要 `seq=44 of=1 to=41`，再次维护 `below-threshold`（不重叠、可重放） |
| 规则 7 中文检索 | 演示 + 用例 | `q=登录模块` 命中 `u_dev_1#1/#3` 且 `tokens=[登录,录模,模块]`；`type=memory` 分组命中；标点/换行边界不跨词元；单字查询走字符回退；Agent 检索他人会话 0 条 |
| 规则 13 原始时间线 | 集成用例 + 演示 | `kind=message` 过滤完整（42 条）、`limit` 尾窗、`fromSeq` 增量一致；`GET /memories` 只读可用 |
| 索引可重建 | 用例 + CLI | 删除/损坏 `index.json` 后查询自动重建；`npm run reindex` 输出「文档 47 条，词元 88 个」 |
| 上下文同源 | `GET .../system-prompt` | blocks = `role-config > platform-role > global-memory > role-memory > session-window > tools`，内容与运行期一致 |
| 前端 | `npm run build` | 构建成功；项目内「记忆与检索」页签可列、可搜、可重建索引 |

## 5. 不做与遗留

- 语义检索、摘要的增量/分段模型路由、记忆条目自动失效策略（超量分层保留）留后续。
- `memory_append` 不触发审批（本进程内写自有记忆，风险 none/low）；全局写入仍无 UI 入口（S6 用户确认路径）。
- 前端只做项目内读与检索；记忆钉住/删除、全局搜索框（跨项目）留 P1。
