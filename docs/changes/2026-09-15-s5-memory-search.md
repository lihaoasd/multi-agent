# 修改记录 · S5 记忆与检索

> 类别：changes · 日期：2026-09-15 · 关联方案：[docs/plan/2026-09-15-s5-memory-search.md](../plan/2026-09-15-s5-memory-search.md) · 总计划：[development.md](../plan/development.md) §6
> 关联设计：[memory.md](../design/memory.md) §3/§4/§5/§9、[data-storage.md](../design/data-storage.md) §5/§10、[agent-runtime.md](../design/agent-runtime.md) §4、[contract.md](../api/contract.md) §2

## 1. 需求 / 问题

S4 结束时对话能跑通，但 Agent **记不住**也**找不到**：L2 滚动摘要、L3 长期记忆、检索三件套都还是设计稿；`memory`/`session` 两个工具包的工具处于"已声明未实现"状态；`npm run reindex` 仍是占位命令（规则 6/7/13 无实现）。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| ports | `ports/memory.ts`、`ports/search.ts`、`ports/viewer.ts`（新增）、`ports/tokens.ts`、`ports/tools.ts` | L3 条目/记忆用例/检索索引与用例端口；访问者类型；Token 23 → 25；工具上下文增 `sourceSeq`（记忆溯源） |
| shared | `shared/text.ts`（新增）、`shared/loop.ts` | 分词/归一化/片段截取（2-gram + 字符回退）；摘要触发阈值与成本护栏常量 |
| domain | `domain/rules/visibility.ts`（新增） | 可见性纯函数（D18-②），工具与 HTTP 检索共用 |
| infra | `infra/file-store/memory-store.ts`、`infra/indexer/keyword-index.ts`（新增）、`infra/tools/builtin/memory.ts`（新增）、`infra/tools/builtin/index.ts`、`infra/tools/packages.ts` | append-only 记忆存储；可重建倒排索引；`memory_append`/`memory_search`/`session_search` 三工具与注册 |
| application | `application/memory/{memory-service,summary-engine}.ts`、`application/search/search-service.ts`（新增）、`application/agent-loop/{context-builder,runner,preview}.ts`、`application/tools/tool-executor.ts` | 记忆写入与白名单；滚动摘要；检索用例；上下文增记忆/检索块与摘要替代窗口 |
| server | `server/http-routes/memory.ts`（新增）、`server/app.ts` | `GET /memories`、`GET /search`、`GET /search/stats`、`POST /search/reindex` |
| bootstrap | `bootstrap/{composition-root,main,reindex}.ts` | 端口/服务装配；`npm run reindex` 真实实现 |
| web | `web/src/api/memory.ts`、`web/src/pages/MemoryPanel.tsx`（新增）、`web/src/pages/ProjectModule.tsx` | 项目内「记忆与检索」页签（列表 + 检索 + 重建索引） |
| docs | `docs/api/contract.md`、`docs/design/{memory,data-storage,agent-runtime}.md`、`docs/plan/development.md` | 契约与设计回写（实现口径） |
| tests | 7 个新文件（见 §4） | 规则 6/7/13 覆盖 |

## 3. 关键决定（与方案一致）

1. **记忆文件 append-only**：`supersede` 追加"同 id 新状态行"，读取同 id 取最后一条；崩溃不产生半更新，历史可审计。
2. **全局记忆写入白名单**：`decision|requirement|progress` 才允许 `recordGlobal`（工具只能写本人角色记忆，越权 → `ERR_FORBIDDEN`）。
3. **摘要阈值 40 条未摘要消息**，不足阈值不调模型；`summary` 事件 `ofSeq/toSeq` 严格不重叠（可重放派生视图）。
4. **摘要成功即提取一条角色 `progress` 记忆**（`source={sessionId,toSeq}`）；决策/需求类全局条目仍留给用户确认路径（S6）。
5. **索引是派生投影**：查询前增量 sync、损坏即空索引重建；`search-index/index.json` 可删，`npm run reindex`/接口可全量重建。
6. **检索可见性 = 读取可见性**（D18-②）：`domain/rules/visibility.ts` 同时服务工具与 HTTP；用户侧不受限。
7. **上下文块顺序按 agent-runtime §4 修正**：`tools` 移到末尾，新增 `global-memory`/`role-memory`，`retrieval` 按需出现；`session-window` 用最近摘要覆盖段 + 其后原文。
8. **单字查询才走字符回退**：长查询不放松匹配（避免"不存在的词汇组合"因单个汉字命中噪声文档）。
9. **infra 不依赖 application**：记忆/检索的用例接口定义在 ports（`MemoryService`/`SearchService`/`Viewer`），application 提供实现——由依赖门禁（ratchet）当场抓出并修正。

## 4. 验证结果

| 验证项 | 结果 |
| --- | --- |
| 类型检查 | `npm run typecheck`（服务端 + 前端）0 错误 |
| 测试 | `npm run test`：**34 files / 231 tests 全通过**（S5 新增 7 文件 47 条） |
| 门禁 | `npm run lint` exit 0；`npm run ratchet` 越层违规 0；`npm run build`（vite）成功 |
| 新增用例 | `shared/text`(9)、`domain/visibility`(4)、`infra/memory-store`(6)、`infra/keyword-index`(9)、`application/memory-service`(5)、`application/summary-engine`(6)、`integration/memory-api`(8) |
| 规则 6 记忆 | 真实组合根演示：角色条目 + 全局条目写入成功，白名单外 `fact` → `ERR_FORBIDDEN`；`GET /memories?scope=global` 1 条、`scope=agent&instanceId=dev_1&state=active` 2 条（含摘要提取条目）；非法 `type` → 400 `ERR_VALIDATION` |
| 规则 6 摘要 | 40 条未摘要消息 → `summary` 事件 `seq=44 of=1 to=41 covered=40 model=mock`，同时落一条 `progress` 角色记忆；再次维护 `below-threshold`（无重叠、可重放） |
| 规则 7 中文检索 | `GET /search?q=登录模块` → `sessionHits` 带 `(u_dev_1, seq)` 与 `tokens=[登录,录模,模块]`；`type=memory` → `sessionHits=0`、记忆分组命中；`stats` 47 文档/88 词元，`reindex` 后仍正确；Agent 视角检索他人会话 → 0 条（可见性） |
| 规则 13 原始时间线 | `GET .../log` 42 条 `message` + 1 `turn_start` + 1 `summary`；`kind=message` 过滤完整；`limit` 尾窗、`fromSeq` 增量一致 |
| 索引可重建 | 删除/损坏 `search-index/index.json` 后查询自动重建；`npm run reindex` 输出「文档 47 条，词元 88 个」 |
| 上下文同源 | `GET .../agents/dev_1/system-prompt`：`role-config > platform-role > global-memory > role-memory > session-window > tools`，记忆块内容与运行期一致 |
| 前端 | `vite build` 成功；项目内新增「记忆与检索」页签（列表 + 检索 + 重建索引） |

## 5. 未做 / 回滚

- 未做：向量检索（P2 扩展点）、记忆钉住/编辑/删除 UI（P1，FR-19）、跨项目全局搜索、索引的增量事件订阅（MVP 用查询前 sync）、决策/需求类全局条目的用户确认写入路径（S6）。
- 回滚：删除 `src/ports/{memory,search,viewer}.ts`、`src/infra/file-store/memory-store.ts`、`src/infra/indexer/`、`src/infra/tools/builtin/memory.ts`、`src/application/{memory,search}/`、`src/domain/rules/visibility.ts`、`src/shared/text.ts`、`src/server/http-routes/memory.ts` 与对应测试，并把 `context-builder`/`runner`/`preview`/`composition-root`/`app` 的注入还原即可；`data/projects/<pid>/{memories,search-index}` 为纯数据，删目录即彻底回退（不影响会话日志）。
