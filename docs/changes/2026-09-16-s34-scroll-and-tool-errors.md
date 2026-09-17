# 修改记录 · S34 会话窗口高度铺满 + 自动跟随最后一条消息；工具报错显示报错内容

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s34-scroll-and-tool-errors.md](../plan/2026-09-16-s34-scroll-and-tool-errors.md)
> 关联设计：[ui.md](../design/ui.md) §4、[prd](../requirements/prd.md) FR-30 / D37

## 1. 需求 / 问题

用户两条口径：

1. **"聊天窗口高度应该和屏幕相对应，保持跟踪追后一个消息"**——现状：消息区高度用 S20 的 `maxHeight: calc(100vh - 350px)`（手算偏移），卡片本身不撑满；且**完全没有滚动跟随**，Agent 连续输出时新内容落在视野下方，用户得反复手动往下滚。
2. **"工具报错。需要显示报错内容"**——现状：`eventRow` 对 `tool_result` 一律 `body: null`（S26"只显示工具名"），失败**只用红色表达**，用户知道错了但**不知道错在哪**。

## 2. 改动范围（仅前端 + 文档 + 测试）

| 层 | 文件 | 说明 |
| --- | --- | --- |
| web | `web/src/pages/SessionPanel.tsx` | ① 会话卡片改为**纵向 flex 容器**：`style={{ flex:1, display:'flex', flexDirection:'column', height:'calc(100vh - 270px)', minHeight:360 }}` + `styles.body={{ display:'flex', flexDirection:'column', flex:1, minHeight:0 }}`；消息区改为 `flex:1, minHeight:200, overflowY:auto`（去掉 `maxHeight`）→ **屏幕多高消息区就多高、输入框钉底**。② 新增 `scrollRef` + `stickToBottom` 状态 + `onScroll`（距底 <40px 视为贴底）；`useEffect([visibleEvents, stickToBottom])` 在贴底时把 `scrollTop` 拉到底 → **跟住最后一条消息，且不与用户抢滚动条** |
| web | `web/src/lib/event-display.ts` | `eventRow` 的 `tool_result` 分支：**失败时** `body = eventBody(event)`（`summary` 里的 `[CODE] message`）、`bodyMode='inline'`，正文为空则回退 `none`；**成功时**维持 `body:null, bodyMode:'none'`（S26 不变）。同步更新类型注释与"一行怎么渲染"说明 |
| tests | `tests/unit/web/event-display.test.ts` | 原"工具结果只显示工具名"用例改为 **成功→只有名字 / 失败→显示报错正文**（断言 `{label:'fs_read_file', body:'[ERR_FORBIDDEN] …', showMeta:false, bodyMode:'inline'}`） |
| docs | `prd`（**D37** + FR-30 补注）、`ui.md` §4、`README.md`、`plan/development.md`、`testing/plan.md`、验收阶段清单 | 全链路回写 |

**未改**：后端与接口（`tool_result.payload.summary` 本来就带错误码与消息）；消息 Markdown 渲染；思考/工具调用（参数默认折叠）与 `error` 事件；询问卡/审批卡位置。

## 3. 关键决定

1. **用 flex 撑满替代继续调 `calc`**：卡片固定为 `calc(100vh - 270px)` 的 flex 列，消息区 `flex:1` —— 不再依赖"猜上方元素总高"（S20 的 350 是手算常数），屏幕变高变矮都自动适配；保留 `minHeight`（卡片 360 / 消息区 200）以免矮窗口把消息区压没。
2. **跟随策略=默认跟住 + 尊重用户上翻**（阈值 40px）：聊天界面的通行做法；`onScroll` 维护 `stickToBottom`，新事件到达时只有贴底才自动滚动。
3. **"成功无噪音、失败给原因"**：S26（成功只显示名字）与 S34（失败显示报错内容）是同一规则的两面，合并口径写进 `ui.md` 与 prd D37，避免以后互相覆盖。
4. **报错正文直接取 `summary`**：生产者在失败时写入 `[${error.code}] ${error.message}`，正是用户要的信息；无需后端改动，也不需要新增字段。
5. **规则仍落在 `eventRow` 纯函数里**：可被单测钉住（延续 S26/S28）。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck / eslint | 0 错误（修掉了一处"`visibleEvents` 在声明前被 effect 引用"的顺序问题：滚动 effect 移到 `visibleEvents` 之后） |
| 前端单测 | `tests/unit/web/` **15 passed**（event-display 9 含新的"失败显示报错"断言 + question-wizard 6） |
| 全量测试 | `npm test` **50 files / 332 tests 全绿** |
| 覆盖率门禁 | `npm run coverage` 142/142；`npm run ratchet` 违规 0 |
| 构建 | `npm run build` 通过；产物 `web/dist/assets/index-D87m1wEH.js`（1,361.06 kB / gzip 426.22 kB）；活体 200 |
| **未覆盖** | 无 DOM 测试：需用户点验 ① 会话窗口高度跟屏幕、输入框在底部 ② 自动跟随最新消息、手动上翻不被打断 ③ 工具报错显示报错正文 |
| 说明 | 与 S4/S7/S12/S15~S33 的交付口径一致 |

## 5. 遗留

- `calc(100vh - 270px)` 仍是**估算偏移**（顶部导航 64 + 内容 padding 48 + 标题栏 + 标签栏 + 卡片头 + 内边距）。比 S20 的 350 更贴合，但若页面再增删一行元素需要同步调整；彻底方案是让 `App` 的 `Content` 与 Tabs 也走 flex 高度链（属布局重构）。
- 自动跟随只针对**消息区**；「待审批 / 待答复询问」卡在消息区下方，长内容仍可能把输入框推远（它们本身不高，暂不处理）。
- 跟随不做"新消息提示条"（如"有新消息 ↓"）：当前直接跟随即可，若以后用户抱怨"上翻时错过新消息"，可加一条提示条（属增强）。
- 工具报错正文是原始 `[CODE] message` 文本（不解析成结构化字段）：够用；若要做"错误码 → 处置建议"，需要一张错误码到建议的映射（新需求）。
- 前端仍无 DOM/组件测试（同类提醒已在 S23/S27/S28/S29/S31/S32/S33 记录）。
