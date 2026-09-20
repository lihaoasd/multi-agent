# 修改记录 · S52 模型请求超时改为「空闲超时」

> 类别：changes · 日期：2026-09-19 · 关联方案：[docs/plan/2026-09-19-s52-model-idle-timeout.md](../plan/2026-09-19-s52-model-idle-timeout.md)
> 关联设计：[model-config.md](../design/model-config.md) §8、[prd](../requirements/prd.md) FR-10 / D55

## 1. 需求 / 问题

用户报告：**`执行失败：模型调用失败（已重试 3 次）：模型流式响应中断：The operation was aborted due to timeout`**。

根因（`src/infra/model/http.ts`）：`AbortSignal.timeout(timeoutMs)` 是**从发起时刻算的固定截止**，且一直挂在请求上约束响应体——**只要一次生成总时长超过 `provider.timeoutMs`（你配的 60s）就被整体砍掉**，哪怕数据一直在正常流。真实场景正好踩中：设计文档 20~35KB、边想边写远超 60 秒 → 报错 + **白白重试 3 次**（每次同样超时）；报错还是 undici 的英文串，看不出是"自己配的超时"。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| infra | `src/infra/model/http.ts` | `timeoutMs` 语义改为**空闲超时**；连接/响应头阶段用独立截止（拿到响应头立即 `clearTimeout`）；响应体套 `withIdleWatchdog`（每次读取重置计时，超时 `abort` 底层请求并给出**中文**原因）；用户 `signal` 仍与看门狗一起参与 `AbortSignal.any` |
| web | `web/src/pages/ModelModule.tsx` | 供应商表单：`超时（毫秒）` → **`空闲超时（毫秒）`** + 说明"多久没收到数据算失败（不是总时长上限）" |
| tests | `tests/unit/infra/model-stream-timeout.test.ts`（新 4） | 见 §4 |
| docs | `prd`（**D55** + FR-10 补注）、`model-config.md` §8、`README.md`、`plan/development.md`、`testing/plan.md`、验收阶段清单加 `s52` | 全链路回写 |

**未改**：`provider.timeoutMs` 默认值（60s 作为空闲阈值够用）；`MODEL_RETRY_LIMIT=3`（空闲超时＝真卡住，重试有意义）；四个适配器的调用形态（修复全部收敛在 `http.ts`）；`requestJson`（listModels/test）也自然获得同一语义。

## 3. 关键决定

1. **"超时"只能有一种合理语义：空闲超时**——只要数据在流，就不该有时间上限；总时长截止会把"正常的长输出"误判成故障。
2. **两段分别约束**：连接阶段必须有截止（否则连不上会干等）；响应体阶段交给会被数据重置的看门狗。
3. **报错要说人话**：直白告诉用户"多久没数据"以及"去哪儿调大"，不再抛底层英文串。
4. **修复收敛在一处**：四个适配器都走 `requestStream`，因此不需要逐个改。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| 新增单测 | `model-stream-timeout.test.ts` **4 passed**：① 数据持续到达、**总时长 360ms ≫ 空闲超时 100ms → 仍读完 6 片** ② 真卡住（100ms 无数据）→ 抛 `空闲超时` ③ 响应头不来 → `模型请求超时…调大超时` ④ 用户取消仍中断 |
| **反向验证** | 把实现临时退回"总时长截止" → 用例 ① **实测红（120ms 失败）**；恢复后 4 条全绿 |
| ⚠️ 修掉一个"假绿" | 第一版替身 fetch **忽略了传入的 `signal`**，导致用例在新旧实现下都通过；已改为跟随 `signal`（真实 fetch 的行为），并在用例注释里写明这个坑 |
| typecheck / eslint | 0 错误（src + web；其间修掉一处 TS 对 `signal.aborted` 的过度收窄） |
| 全量测试 | `npm test` **65 files / 401 tests 全绿** |
| 覆盖率 / 依赖门禁 | `npm run coverage` **143/143**；`npm run ratchet` 违规 **0** |
| 构建 | `npm run build` 通过；产物 `web/dist/assets/index-_R5D1iNe.js`（1,377.64 kB / gzip 431.37 kB） |
| **未覆盖** | 真实供应商行为无法在本机自动化：**须用户点验** —— 再跑一次之前超时的长回合，应不再出现 `aborted due to timeout` |
| 说明 | 与 S15~S51 的交付口径一致 |

## 5. 遗留

- **静默期较长的供应商**（思考阶段长时间不吐字）：仍会按空闲阈值失败；需要更久就把"空闲超时"调大（表单已说明），或让适配器把 `reasoning-delta` 也作为活跃信号（当前只有 `text-delta` 会重置看门狗——注意：看门狗重置依据是**收到任意字节**，因此供应商只要有 keep-alive 或任何帧就不会误判）。
- **重试仍会重跑整轮**：`MODEL_RETRY_LIMIT=3` 对"同一个请求反复卡住"会在日志里刷 3 次；若将来想区分"网络抖动"与"供应商容量不足"，可按错误码分类退避。
- **超时值仍是供应商级**：一个供应商下所有模型共用一个空闲阈值；若某些模型明显更慢，可在模型条目级加覆盖（未做）。
