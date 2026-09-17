# 修改记录 · S26 工具结果条目只显示工具名

> 类别：changes · 日期：2026-09-16 · 关联方案：[docs/plan/2026-09-16-s26-tool-result-name-only.md](../plan/2026-09-16-s26-tool-result-name-only.md)
> 关联设计：[ui.md](../design/ui.md) §4、[prd](../requirements/prd.md) FR-30 / D31

## 1. 需求 / 问题

用户口径：**"工具结果条目，不要显示其他东西，只要显示工具调用名称"**。

S24 之后工具结果行是「`工具结果（失败） <name> · #seq · turn N` + 结果全文」——对用户来说正文太长、噪音多，用户要的只是"知道这个工具跑完了"。

## 2. 改动范围（仅前端 + 文档）

| 层 | 文件 | 说明 |
| --- | --- | --- |
| web | `web/src/lib/event-display.ts` | `eventLabel` 的 `tool_result` 分支改为返回**工具名本身**（不再有"工具结果/（失败）"字样）；新增 `EventRow { label, body, showMeta }` 与 **`eventRow(event)`**——把"一行怎么渲染"提成纯函数：工具结果 → `body: null`、`showMeta: false`；其余 → 标题 + 正文 + 序号 |
| web | `web/src/pages/SessionPanel.tsx` | 非消息行的渲染改用 `eventRow(event)`：`showMeta` 为假时只渲染标题（失败时**加粗**，颜色仍由 `isToolFailed` 驱动整行标红），`body === null` 时不渲染正文 |
| tests | `tests/unit/web/event-display.test.ts` | 新增 `eventRow` 用例（工具结果 → `{ label: 'fs_read_file', body: null, showMeta: false }`；工具调用/思考/错误 → 标题+正文+序号）；更新原先断言"结果行标题带『工具结果』字样"的用例 |
| docs | `ui.md` §4、`prd` FR-30 补注 + **D31**、`README.md`、`plan/development.md`、`testing/plan.md`、验收阶段清单 | 全链路回写 |

**未改**：后端 `session_recent`（**Agent 自查视图仍带结果文本**——那是 Agent 的判据）；工具调用行（仍是 `工具调用 <name>` + 格式化参数）；思考/错误行。

## 3. 关键决定

1. **"一行怎么渲染"提成纯函数 `eventRow`**：原来"标签、正文、序号"三件事散在 JSX 里，规则只能靠点验；提出来之后"S26：工具结果只显示工具名"这条能被**单测钉住**（延续 S23/S24 把前端逻辑纯函数化的做法）。
2. **字面执行"不要显示其他东西"**：结果行的标题就是工具名，正文为空，序号/回合信息不显示——连"工具结果"四个字都不加。
3. **失败用颜色而不是文字**：整行标红 + 工具名加粗，满足"不加其他东西"的同时保留"看得见失败"（否则一次工具报错会在流里彻底沉默）。
4. **只改用户界面**：`session_recent`（Agent 用）结果正文照旧；如果连它也清掉，Agent 就无法判断工具成功与否，与 S21"让 Agent 自己判断"的初衷冲突。
5. **保留工具调用行的参数**：用户只点了"工具结果条目"；调用行保留 `工具调用 <name>` + 格式化参数（S24 的成果）。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| typecheck / eslint | 0 错误 |
| 前端单测 | `tests/unit/web/` **19 passed**（markdown 11 + event-display 8） |
| 全量测试 | `npm test` **49 files / 329 tests 全绿** |
| 覆盖率门禁 | `npm run coverage` 141/141；`npm run ratchet` 违规 0 |
| 构建 | `npm run build` 通过（产物 `web/dist/assets/index-ZVM0m1fG.js`） |
| 产物冒烟 | 产物不再含 `工具结果（` 字样（该分支已无此文案），仍含 `工具调用` |
| **未覆盖** | 无浏览器自动化：需用户刷新后确认"结果行只有工具名""工具报错时整行变红""工具调用行仍有参数" |
| 说明 | 与 S4/S7/S12/S15~S25 的交付口径一致 |

## 5. 遗留

- 结果正文在界面上**完全不可见**（用户明确要求）。若将来想"点工具名展开结果"，需要一个展开交互（可复用 `session_recent` 或 `GET .../sessions/:sid/log` 数据），属新增需求。
- 失败信息也只有"颜色"这一个信号：若工具失败原因需要看到，得回到会话日志或让 Agent 自己汇报。
- `eventBody`/`eventLabel` 仍保留为构件（`eventBody(tool_result)` 现在只服务于非界面用途与测试）；若后续确认无消费者，可随下次清理合并掉。
