# 2026-09-12 ask_user 改为「问题列表」：一次调用问多件事、一张卡片一次答完

## 需求/问题

用户："这 3 个问题不是应该放在一起，调一次 ask_user，应该是一个问题列表"。

背景（同日实测）：项目经理一轮里想拍板 3 件事，模型**并发发了 3 个 `ask_user`**，
后两个撞上"同会话只允许 1 条待答"的规则被拒 → 界面上看起来像"同一个问题问了三次"，
而且那两件事**被丢掉了**。正确的形态应该是：**一次调用带一组问题（问题列表）**，
平台在一张卡片里逐题呈现，用户**一次答完提交**。

## 改动范围

### 一、数据模型：`QuestionRecord.items`（问题列表）

```jsonc
{ "id":"q_…", "sessionId":"u_product_1", "asker":"product_1",
  "items":[
    { "id":"q_…_1", "question":"目标平台？", "kind":"single", "options":["Web","桌面"], "allowText":true, "answer":null },
    { "id":"q_…_2", "question":"功能范围？", "kind":"multi",  "options":["难度","音效"], "allowText":false, "answer":null }
  ],
  // 兼容/摘要字段：单题=题干；多题="共 N 个问题"（列表、角标、待办标题用）
  "question":"共 2 个问题", "kind":"single", "options":[], "allowText":false,
  "status":"pending", "answer":null, "createdAt":"…", "answeredAt":null }
```

- 一条记录 = 一张卡片 = 1..N 题；`MAX_ASK_ITEMS = 6`（防问卷轰炸）。
- **旧数据兼容**：`readAll()` 对没有 `items` 的历史记录自动包装成 1 题（`normalizeRecord`），
  写入路径不变。
- 去重：同一批问题（各题文本归一化后拼接相同）不重复建。

### 二、工具 `ask_user`：支持 `questions` 数组

- schema 新增 `questions: [{question, kind, options, allowText}]`（推荐用法）；
  单题简写 `question/kind/options/allowText` 保留兼容。
- 回执列出题号：`已向用户提问（q_…，3 个问题）：\n1) 目标平台？\n2) 功能范围？\n3) 技术栈？`
  + 「用户会在**同一张卡片里逐题作答、一次提交**」+ `suspend: true`（挂起本回合）。
- 系统提示同步：**一次要问多件事就用一次调用传 `questions` 数组**，不要并发多次调用、不要分多轮追问。

### 三、回答：一次提交全部答案

- `POST /api/projects/:pid/questions/:qid/answer` 支持
  `{ answers: [{ itemId?, choice?, choices?, text? }] }`（推荐；`itemId` 缺省按顺序对齐）；
  旧写法 `{choice/choices/text}` 仍可用于单题。
- **每题必答**：缺题报「第 N 题还没回答：…」，按 kind 逐题校验（选项越界点名"第 N 题"）。
- 答复文本逐条列出（写回会话的用户消息）：
  ```
  【回答提问 q_…】共 3 个问题
  1) 目标平台选哪个？
  → Web
  2) 要包含哪些功能？
  → 难度、音效
  3) 技术栈偏好？
  → 原生 JS
  ```

### 四、前端：一张卡片、逐题作答、一次提交

- `buildQuestionCard(q)` 改为渲染 **`q.items`**：每题一个 `.q-item`（题号 + 题干 + 对应控件），
  底部**一个**提交按钮（多题时显示「提交全部回答（N 题）」）。
- `submitQuestionAnswer()` 收集每题答案 → `{answers:[...]}`；本地先做一次必答校验
  （提示「第 N 题还没选/还没填」），失败不发请求。
- 「需你处理」待办标题也改为：多题时 `X 问你 N 个问题：<第一题>…`，详情列出全部题干。
- 样式：`.q-item` / `.q-item-idx`（题号高亮）。

### 五、队列的定位变化

同日先做的"提问队列（`queued`）"仍保留：它现在只在**角色分了多轮/多次调用**时兜底
（正常用法下模型应一次带列表）。两套机制不冲突：一条记录内部是多题，记录之间才排队。

## 测试

新增 `tests/question-list-m8u.test.ts`（9 例）：
一次 `ask(questions:3)` 只落 1 条记录 / items=3 / 摘要"共 3 个问题"；
缺题报错且不落 answered；一次提交全部答案（逐题答案 + 答复文本逐条）；
选项校验按题定位；`ask_user` 工具传 `questions` 数组（一条待答 + suspend + 回执列题号）；
HTTP `{answers}` 一次提交并多行写回会话；超过 6 题被拒 & 单题简写兼容；
**旧格式记录自动归一化为 1 题**；**模型一轮问多件事只调用一次 ask_user 即挂起**。

## 验证结果

- `npx tsc -p tsconfig.json` → 0；`npx eslint .` → 0；`node --check web/app.js` → 0
- `npx vitest run --pool=threads` → **35 文件 / 213 用例全绿**

## 边界

- 一次最多 6 题；题与题之间**不支持条件依赖**（如"选 A 才显示第 3 题"）。
- 问题列表要求**全部答完**才提交（不支持部分提交）；如需"先答一部分"，目前要拆成多条提问（会进队列）。
- 图片/文件类问答仍不支持（沿用 confirm/single/multi/text 四类）。
