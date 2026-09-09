# 修改记录 · Agent Haness

> 位置：docs/changes/，按日期追加；遵循项目 skill 的 change-record 约定。

## 2026-09-08 M5 记忆与检索（L3 记忆 + 滚动摘要 + 关键词倒排索引 + 搜索）

- 需求/问题: 完成 M5 里程碑：L3 长期条目(角色/全局)、会话滚动摘要(summary 事件+summaryRefs)、关键词倒排索引(中文 2-gram，可再生)与搜索 UI 后端、记忆只读列表。用户已解除逐阶段确认，自主推进。
- 类型: 代码(新建) + 测试
- 改动范围:
  1. `src/application/memory/memory-store.ts`：memories/global.jsonl + memories/<iid>.jsonl；条目 schema(type∈fact/decision/preference/commitment/requirement/progress/meeting_summary/artifact_index)；append/supersede(保留原行)/listActive(按 scope/type/limit 过滤)。
  2. `src/application/memory/summary-engine.ts`：滚动摘要触发（距上次摘要 ≥20 条事件）→ 规则式 digest（MVP：抽取问题/结论/产出物行）→ 写 `summary` 事件 + meta.summaryRefs 登记；真实模型生成留 M8（字段契约与 data-storage §4.2/memory.md §3.1 一致）。
  3. `src/application/search/search-service.ts`：倒排索引（search-index/<pid>/idx.json，派生可重建：缺失即自动全量重建）；中文 2-gram+英文字词切分；范围=会话日志+记忆；结果按 会话/记忆 分组，命中带上下文片段（跳转用 sessionId+seq）。可见性由调用侧（用户全量）决定，Agent 侧复用规则留 M8 工具接入。
  4. `src/application/session/session-service.ts`：回合完成后触发 maybeSummarize。
  5. `src/application/composition.ts`：注入 memory/summary/search；`src/server/app.ts`：GET /api/projects/:pid/search、GET /memories。
  6. `tests/memory-m5.test.ts`：4 用例（MemoryStore global/role+superseded、中文关键词命中分组、索引生成且删除后自动重建、memories REST）。
- 原因: M5 交付"摘要生效、搜索可跳转、重启可恢复含摘要"的服务端能力。
- 行为变化: 长会话回合结束自动产生滚动摘要事件并登记 summaryRefs；中文关键词可跨会话/记忆检索，索引损坏/缺失自动重建。
- 验证: `npm run test` 82/82；tsc 0 错；eslint 0 错。
- 测试: memory-m5 4 用例。
- 遗留(说明): 真实模型摘要/纪要生成与会议纪要分发(M6 结束后)、Agent 侧 session_search/memory_search 工具(可见性规则 D18-②)在 M6/M8 补齐；搜索 UI 前端入 M7。
