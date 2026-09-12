# 2026-09-12 数据丢失修复 + 收尾补强（workdir_edit 清空文件 / 推理吃满预算）

## 需求/问题

用户第二次反馈同样两条："1. 产品经理分派完，角色完成任务，没有修改任务状态。2. 角色完成自己的任务后，需要总结告知用户。"

上一轮（`171a207`）加了收尾回合与兜底提示后仍复现，说明还有更深的原因。**逐条读本机真实项目日志后定位到两个根因**：

### 根因 A（数据丢失，最严重）：`workdir_edit` 会把整文件清空

`data/projects/p_mtxzmn308w5bbj/sessions/u_product_1.log.jsonl` seq36：模型发了一条**漏 `type` 字段**的编辑
`{oldText:"…", newText:"…"}`，而实现是：

```ts
const type = String(e.type ?? 'write')   // 缺省当成 write
current = String(e.text ?? '')           // text 不存在 → current = ''
await writeFile(abs, current)            // 7742 字的 docs/prd.md → 0 字节
```

回执还显示"（无净变化）"，因为增量按 `current.length` 累加（空串=0）→ **用户磁盘上的 `docs/prd.md` 被写成 0 字节**。
模型随后 `fs_read_file` 读到空内容，以为文件损坏，连续 5 步反复读取核对，把回合耗完 →
**既没上报任务状态，也没给完成总结**（用户看到的两条现象）。

### 根因 B：推理模型把输出预算全花在"思考"上

`u_architect_1` 回合：模型产出了超长 reasoning（thinking）后**没有正文、没有工具调用**，
平台只能落一句兜底文本"（模型本次只给出了思考过程、未输出正文…）"→ 任务停在进行中。
`max_tokens` 固定 8192 且不可配置，推理与正文共享同一预算。

## 改动范围

### 一、数据安全（`src/application/tools/service-tools.ts`）

- **类型推断**：`type` 缺省时按字段推断 —— 有 `oldText`/`newText` → `replace`；有 `text` → `write`；
  都没有 → 明确报错（不再默认成 `write`）。
- **写入保护**：`write` 必须**显式提供 `text` 字段**（缺失即拒绝：避免误清空）；`text` 为空串也拒绝
  （"拒绝对工作目录文件写入空内容"）。
- **回执诚实**：`+N 字符` 改为真实净变化 `current.length - originalLength`
  （旧实现写空文件时会误报"无净变化"），`codeEdits` 的 `changedChars` 同步修正。
- 事务语义不变：任一编辑失败 → 整笔不改文件（`ERR_CONFLICT` 提前返回）。

### 二、推理吃满预算的重试（`loop-runner.ts` + `openai-compatible.ts` + `gateway.ts`）

- provider 解析 `finish_reason`，`ChatStreamItem` 新增 `finishReason`。
- 配置支持 `models.providers[].maxTokens`（网关透传；`config.yaml` 注释说明可按 provider 上限调大）。
- 循环新增**"裸步"重试**（每回合至多一次）：某一步只有思考（或 `finish_reason=length`）、没有正文也没有工具调用时，
  注入「上一步只产生了思考…请**直接继续**：需要动手就调用工具；否则给出结论/总结。不要再写长篇推理」并重试一次。
- 与上一轮的**收尾回合**（步数用尽 / 模型空手停下）叠加，形成三层保障：重试 → 收尾回合 → 回合末系统提示。

### 三、其他

- `PATCH /api/projects/:pid/tasks/:tid` 支持 `note`（用户/协调者干预时也能留完成总结）。
- 兜底提示改为**回合末重新读取任务状态**（上一轮用的是回合开始快照，而角色常在回合中途 `task_claim` → 快照漏掉 → 提示不触发）。

## 测试

- 新增 `tests/workdir-edit-safety-m8q.test.ts`（6 例）：漏 `type` 的编辑按 replace 处理、`write` 缺 `text` 拒绝、
  空 `text` 拒绝、无字段报错、replace 失败整笔回滚、大文件在"事故形态"输入下保持完好。
- 新增 `tests/reasoning-retry-m8r.test.ts`（3 例）：只出思考 → 重试一次并拿到正文；重试仍失败 → 平台兜底文案；正常正文不重试。
- 扩展 `tests/task-completion-m8p.test.ts`（+2 例）：模型空手停下 → 收尾回合仍上报完成并给总结；
  回合中途才领取 → 兜底提示按最新状态触发。

## 验证结果

- `npx tsc -p tsconfig.json` → 0；`npx eslint .` → 0
- `npx vitest run --pool=threads` → **32 文件 / 195 用例全绿**

### 真实模型端到端验证（用户本机 3000 端口，DEEPSEEK_API_KEY）

事故项目 `p_mtxzmn308w5bbj`（工作目录 `D:\迅雷下载\aaa\01`）复跑：

```
任务 t_mtxzpf4uak1vaf（卡在进行中的"补完技术方案"）
  → 重新触发一轮 → docs/tech-design.md 7829 → 31584 字节（§4–§13 全部补齐）
  → 任务状态 done，resultNote: "已补完 docs/tech-design.md 至 v1.1 完整可实施版：续写 §4-§13…遗留唯一待拍板项为 §8.3…"
任务栏最终 5 条任务全部 done，且每条都带完成总结：
  t_mty0jg8dtj7eg4 done  docs/prd.md 升 v1.2（§9 画布逻辑尺寸 20×20 更正…）
  t_mtxzpf4uak1vaf done  已补完 docs/tech-design.md 至 v1.1…
  t_mty0hmgeb4fm4m done  已交付 docs/test-cases.md v1.0（44 条用例…）
  t_mty0hmf16q1daw done  逐条复核 docs/prd.md（平台重建的 v1.0）→ v1.1…
  t_mtxzpf3gk8cysh done  （平台恢复说明）
产出文件：prd.md 15869 / tech-design.md 31584 / test-cases.md 21262 字节
```

## 事故善后（对用户数据）

- `docs/prd.md` 被清空后**无法从日志逐字恢复**（审计日志对工具输入/读取结果做了摘要截断：只保留 ~200 字 + "…(7742字)"），
  且当时 `artifact-submit` 未执行、无版本快照，旧项目目录已被删除。
- 处理：按任务 `t_mtxzpf3gk8cysh` 的定稿要求（D1–D7）与日志中可得的片段**重建 v1.0**（10526 字节，
  文件头注明"平台重建/恢复说明"），并把该任务置 `done`（actor=user）并写入说明。
  随后用户侧的 product_1 复核并升到 v1.1/v1.2，说明重建内容可用。

## 边界

- 空内容写入一律拒绝：如某天确需清空文件，目前需要走"写一个占位内容"或人工删除（有意为之的安全取舍）。
- 裸步重试每回合至多一次（避免与模型反复拉锯消耗预算）；仍失败则依赖收尾回合与平台兜底提示。
- `maxTokens` 默认仍是 8192（未在 `config.yaml` 里硬调大，避免不同 provider 上限不一致直接报错）。
