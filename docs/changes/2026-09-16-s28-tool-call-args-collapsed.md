# 修改记录 · S28 工具调用参数默认折叠

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s28-tool-call-args-collapsed.md](../plan/2026-09-16-s28-tool-call-args-collapsed.md)
> 关联设计：[ui.md](../design/ui.md) §4、[prd](../requirements/prd.md) FR-30 / D33

## 1. 需求 / 问题

用户口径：**"工具调用参数默认不展开"**。

S24 之后工具调用行是「`工具调用 <name> · #seq · turn N` + 参数 JSON 直接铺开」——参数一长就把会话流撑乱。

## 2. 改动范围（仅前端 + 文档）

| 层 | 文件 | 说明 |
| --- | --- | --- |
| web | `web/src/lib/event-display.ts` | `EventRow` 增 **`bodyMode: 'inline' \| 'collapsed' \| 'none'`**；`eventRow` 按 kind 决定：**tool_call → `collapsed`**（无参数则 `none`）、tool_result → `none`、思考/错误等有正文 → `inline`、无正文 → `none` |
| web | `web/src/pages/SessionPanel.tsx` | `showMeta && bodyMode === 'collapsed'` 时用 antd **`Collapse`（`ghost` + `size="small"`）** 渲染：label = `标题 · #seq · turn N`、children = 参数 `<pre>`（等宽、`pre-wrap` + `break-all`）；**不传 `defaultActiveKey`**（默认折叠）；`inline` 时照旧直接展示正文；重新引入 `Collapse` import（antd 已有依赖，无新增包） |
| tests | `tests/unit/web/event-display.test.ts` | `eventRow` 期望补 `bodyMode`；新增"工具调用无参数 → `body: null` + `bodyMode: 'none'`"用例（**9 passed**） |
| docs | `prd` FR-30 补注 + **D33**、`ui.md` §4、`README.md`、`plan/development.md`、`testing/plan.md`、验收阶段清单 | 全链路回写 |

**未改**：工具结果条目（仍只显示工具名，S26）；思考/错误条目（仍直接展示正文）；后端与接口；依赖（未新增包）。

## 3. 关键决定

1. **"正文怎么呈现"进 `eventRow` 规则**：`bodyMode` 让"默认折叠"成为**可单测**的规则，而不是 JSX 里的隐式行为（延续 S26 把行渲染规则纯函数化的做法）。
2. **用 antd `Collapse` 而不是自研展开状态**：antd 已是依赖（无新增包），`Collapse` 自带展开箭头、键盘可达、未展开时不渲染内容；S22 删掉它是因为"工作日志包装"被取消，与组件本身无关。
3. **默认折叠 = 不传 `defaultActiveKey`**；**无参数时退化为纯标题行**（不出现"点开是空白"的假折叠）。
4. **只动工具调用**：思考/错误 inline、工具结果只有名字，保持 S26 口径。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck / eslint | 0 错误 |
| 前端单测 | `tests/unit/web/event-display.test.ts` **9 passed**（含 `bodyMode` 三态与无参数退化） |
| 全量测试 | `npm test` **48 files / 319 tests 全绿** |
| 覆盖率门禁 | `npm run coverage` 141/141；`npm run ratchet` 违规 0 |
| 构建 | `npm run build` 通过；产物 `web/dist/assets/index-e2OlvyIm.js` **1,356.70 kB（gzip 424.96 kB）**（上一版 1,346.52 kB，+10 kB 来自重新引入 antd `Collapse`） |
| 活体 | `GET /assets/index-e2OlvyIm.js` 返回 200 |
| **未覆盖** | 无浏览器自动化：需用户刷新后确认"工具调用行默认折叠、点击展开看到格式化参数、无参数时没有空面板、工具结果行仍只有工具名" |
| 说明 | 与 S4/S7/S12/S15~S27 的交付口径一致 |

## 5. 遗留

- 展开/折叠状态是**组件内非受控**（`Collapse` 默认行为）：切换会话或刷新后回到默认折叠。若要"记住我展开过哪几条"，需要引入受控状态或落 `localStorage`（属新需求）。
- 参数很长时展开仍可能占很高：当前靠 `pre-wrap` 换行 + 气泡 `maxWidth: 85%`；如需"展开后限高 + 内部滚动"，可再加 `maxHeight`。
- 会话流仍无 DOM 级测试：折叠交互属渲染层行为，靠 build + 审阅 + 用户点验（DOM 测试环境待单独立项，已在 S23/S27 记录）。
