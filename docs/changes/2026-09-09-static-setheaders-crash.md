# 2026-09-09 修复静态资源崩溃：`res.setHeader is not a function`（@fastify/static v10）

> 类别：changes · 需求来源：用户运行时报错
> `TypeError: res.setHeader is not a function at setHeaders (src/server/index.ts:49)`

## 根因

上一版为避免浏览器缓存旧前端，给 `@fastify/static` 加了 `setHeaders`，但用错了对象：

- `@fastify/static` **v10** 的 `setHeaders(res, path, stat)` 回传的是 **FastifyReply**（`index.js:442` 里
  `setHeaders?.(reply, …)`），只能用 `reply.header(...)`；
- 我写成了原生 `ServerResponse` 的 `res.setHeader(...)`（还用 cast 绕过了类型检查）→
  每个静态请求都会抛 `TypeError`，静态资源（含页面）直接崩。

教训：**类型断言掩盖了真实契约**，而这条路径此前没有测试覆盖（静态托管写在 `index.ts`，测试只构建 `buildApp`）。

## 修复

- `src/server/index.ts`：`setHeaders: (reply) => reply.header('Cache-Control', 'no-cache')`（去掉 cast）。
- **把静态托管移进 `buildApp(svc, { webDir? })`**（`src/server/app.ts`）：`index.ts` 传 `webDir`，
  测试可传同一目录 → 这条路径终于可被测试覆盖；不传 `webDir` 时不注册（测试注入更干净）。

## 验证

- 新增 `tests/static-web-m8k.test.ts`（真实请求路径，`fastify.inject`）：
  `GET /` → 200 + `text/html` + `Cache-Control: no-cache`；
  `GET /app.js` → 200 + `application/javascript` + `no-cache` + 含 `connectWs`；
  `GET /style.css`、`/markdown.js` → 200 + `no-cache`；
  不传 `webDir` 时 `/` 为 404 而 API 正常。
- **真实进程验证**（`node dist/server/index.js`，HTTP 抓取）：
  `/app.js` 200 + `Cache-Control: no-cache` + `application/javascript`、`/` 200、`/style.css` 200、
  `/api/projects` 200 —— 不再有 `setHeader` 异常。
- `npx tsc`、`npx eslint .` 通过；`npx vitest run --pool=threads` **147 用例全绿**。

## 遗留（说明）

- 静态资源统一 `no-cache`（每次校验，靠 ETag/Last-Modified 走 304），生产如需强缓存可改成带 hash 的资源名策略。
