# S52 方案：模型请求超时改为「空闲超时」（修真实超时事故）

> 日期：2026-09-19　类型：用户报告（"执行失败：模型调用失败（已重试 3 次）：模型流式响应中断：The operation was aborted due to timeout"）　真源：`design/model-config.md` §8、`prd.md` FR-10
> 关联：`docs/changes/2026-09-19-s52-model-idle-timeout.md`、`docs/plan/development.md`

## 1 需求与根因

用户报告的错误：**`模型调用失败（已重试 3 次）：模型流式响应中断：The operation was aborted due to timeout`**。

根因（`src/infra/model/http.ts`）：

```ts
function timeoutSignal(signal, timeoutMs) {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])   // ← 从发起时刻算的固定截止
}
...
response = await fetch(url, { ..., signal: timeoutSignal(signal, timeoutMs) })
return ok(response.body)   // ← 这个 signal 一直挂在请求上，响应体也受它约束
```

`AbortSignal.timeout()` 是**总时长截止**，不是"多久没数据"。于是：

- 只要一次生成（含思考）**从头到尾超过 `provider.timeoutMs`（默认/你配的是 60s）就被整体砍掉**——
  哪怕数据一直在正常流；
- 真实场景正好踩中：设计文档 20~35KB、边想边写远超 60 秒 → 报错、还**白白重试 3 次**（每次都同样超时）；
- 报错文案是底层 undici 的英文串（`The operation was aborted due to timeout`），用户看不出"是我配的超时"。

## 2 修复

| # | 改动 | 说明 |
| --- | --- | --- |
| ① | **超时口径改为"空闲超时"** | `timeoutMs` 语义＝"多久没有数据到达就算失败"；**数据持续到达时不设总时长上限** |
| ② | **两段分别约束** | **连接/响应头阶段**：独立截止（`headerDeadline`，拿到响应头立即 `clearTimeout`）；**响应体阶段**：`withIdleWatchdog` 每次读取重置计时，超时即 `abort` 底层请求 |
| ③ | **可读的中文报错** | 空闲超时 → `模型流式响应空闲超时：N 秒没有数据到达（可在「模型 → 供应商」调大超时）`；响应头超时 → `模型请求超时：N 秒内没有拿到响应（…）`；不再把 undici 英文串直接抛给用户 |
| ④ | **用户取消不受影响** | `signal`（停止生成/停止任务）仍与看门狗一起参与 `AbortSignal.any`——取消照常立刻中断 |
| ⑤ | **UI 文案** | 供应商表单字段 `超时（毫秒）` → **`空闲超时（毫秒）`** + 说明"多久没收到数据算失败（不是总时长上限）" |

**不改**：`provider.timeoutMs` 的默认值（60s 作为空闲阈值够用）；重试策略（`MODEL_RETRY_LIMIT=3`——空闲超时意味着"真的卡住了"，重试有意义）；四个适配器的调用形态（修复全部收敛在 `http.ts` 内）。

## 3 验证方式

| 层 | 手段 |
| --- | --- |
| 单元（核心） | 新增 `tests/unit/infra/model-stream-timeout.test.ts`：① **数据持续到达、总时长 360ms ≫ 空闲超时 100ms → 正常读完 6 片**（旧实现必红）② 真卡住（100ms 无数据）→ 以 `空闲超时` 原因失败 ③ 响应头不来 → `模型请求超时…调大超时` ④ 用户取消仍中断 |
| **反向验证** | 把实现临时退回"总时长截止"→ 用例 ① **必红**（实测 120ms 失败）；恢复后 4 条全绿 |
| ⚠️ 替身要求 | 替身 fetch **必须跟随传入的 `signal`**（真实 fetch 就是这样）。第一版替身忽略了 signal，用例在新旧实现下都通过——**假绿**，已修正并在用例里写明这个坑 |
| 回归 | `npm test` 全绿 + `coverage` + `ratchet` + `typecheck`/`eslint` + `npm run build` |
| **用户点验** | 再跑一次之前超时的长回合（写大文档）：**不再出现 aborted due to timeout**；若真卡住，错误应为中文的"空闲超时…可在「模型 → 供应商」调大超时" |

## 4 风险

| 风险 | 对策 |
| --- | --- |
| 真·卡死的请求占住回合更久 | 空闲阈值仍是 `timeoutMs`（默认 60s）；只是"正在流"不再计入 |
| 看门狗自己出错把好流掐掉 | 每次读取前设时、读到即清；`cancel` 会连带取消底层 reader |
| 供应商中途静默很久（如长思考无输出） | 这正是"空闲"的定义——此时按配置超时失败并给出中文提示；需要更久就把空闲超时调大（表单已说明） |
| 与"用户取消"混淆 | 报错文案区分：取消走原 `signal` 路径（`ERR_MODEL` + 原始原因），空闲超时走中文提示 |
