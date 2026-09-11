# 2026-09-09 请求风暴根除（`ERR_INSUFFICIENT_RESOURCES`）+ 提问卡片不显示

> 类别：changes · 需求来源：用户反馈"角色处于等待你处理但询问框没出来；控制台大量
> `GET /api/projects/<pid>/sessions net::ERR_INSUFFICIENT_RESOURCES`"

## 根因

1. **`api()` 没有超时**：服务端繁忙（8 个角色后台干活）时请求会一直挂着不返回，
   前端又按定时器不断发起新请求 → 连接数无限累积 → 浏览器报 `ERR_INSUFFICIENT_RESOURCES`。
2. **上一版合并刷新只做了"节流"，没做"限并发"**：上一批请求还没回来，下一批又被排上，
   仍然会堆积（每批面板刷新本身就是 8 个请求）。
3. 连接被耗尽后**所有** fetch 都失败（包括 `/questions?status=pending`）→
   问题卡片拿不到数据，于是出现"角色等待你处理、但询问框不显示"。
   实测数据确认卡片本该出现：该项目的 `questions.jsonl` 里确有 pending 提问
   （`u_product_1` 单选、`u_architect_1` 单选），`/sessions` 也能正常返回 8 个会话与未读数。
4. 另一个隐性因素：静态资源没有 `Cache-Control`，浏览器可能一直在跑**缓存的旧 app.js**
   （旧版就是逐事件请求的那个版本），导致修复看起来"没生效"。

## 修复

- **`api()` 加超时**（AbortController，默认 15s；支持外部 signal）→ 挂死请求会被主动终止，不再累积。
- **并发安全的合并调度器 `createCoalesced(delay, run)`**：
  同一类刷新同时**只允许一个在飞**，期间只记一次"待办"，跑完再排一次；
  面板 1.2s / 未读 3s / 角色状态 5s；`agentStatusTimer` 也改走该调度器。
- **未读刷新只由"落盘事件"触发**：其它会话的流式分片（chunk/thought.chunk）不改变 `lastSeq`，
  不再触发 `/sessions` 请求（这是此前请求量最大的来源）。
- **静态资源 `Cache-Control: no-cache`**（`src/server/index.ts` 的 `@fastify/static setHeaders`）：
  浏览器每次校验，杜绝"旧 app.js 常驻"。
- 小改进：团队行"等待你处理"徽标加 tooltip（点击进入该角色会话回答）。

## 验证

- 只读核查（不启动第二个服务、避免与用户运行的实例争数据）：
  `svc.questions.list(pid,{status:'pending'})` → 1 条待答（`u_product_1`，single，3 选项）；
  `svc.sessionService.listSessions(pid)` → 8 个会话，`u_architect_1`/`u_product_1` 分别有 13/9 未读 —— 数据侧完全正常。
- `npx tsc`、`npx eslint .` 通过；`npx vitest run --pool=threads` **145 用例全绿**。
- 使用方需做一次：**重启服务**（生效 `no-cache` 头）+ **Ctrl+F5 强刷**（加载新 app.js）。

## 遗留（说明）

- 未读仍靠轮询（3s 一次合并请求）；如需彻底去掉，可让 `session.updated`/`event.appended` 事件带上 `unread` 字段、
  前端本地维护（此前已提出，未实施）。
- `/sessions` 每次读该项目全部会话 meta（O(会话数) 次文件读），9~10 个会话下开销很小。
