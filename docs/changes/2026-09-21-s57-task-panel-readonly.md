# 修改记录 · S57 「任务与产出物」用户只读（不派单、不改状态）

> 类别：changes · 日期：2026-09-21 · 关联方案：[docs/plan/2026-09-21-s57-task-panel-readonly.md](../plan/2026-09-21-s57-task-panel-readonly.md)
> 关联设计：[ui.md](../design/ui.md) §5、[data-storage.md](../design/data-storage.md) §7、[agent-runtime.md](../design/agent-runtime.md) §6、[contract.md](../api/contract.md)、[prd](../requirements/prd.md) FR-08 / D61（修订 D59 的面板口径）

## 1. 需求

用户口径：**"任务与产出物里，用户不能派单和修改任务状态"**。

这句话有"点了没生效"（要修好）与"不该让用户做"（要去掉）两种读法，先问了一句，用户选择：

> **去掉这两个入口：用户只读（不能派单、不能改状态），任务由 PM/角色推进。**

（之所以不是"修好"：`POST /tasks`、`PATCH /tasks/:tid` 两条接口都正常，派单下拉能拿到 8 个启用角色，用户项目里 15 条任务**全部** `creator=pm_1`——复现不出"点了没生效"。）

口径定位：面板是**观察窗**，不是操作台；派发与状态流转全由角色驱动（PM 按职能 `task_assign` → 受派人 `task_claim` → 执行 → `task_update` 汇报）。与 S50/D53（按职能派单）、S56/D60（产出物表只读）一脉相承。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| web | `web/src/pages/WorkPanel.tsx` | 删「派单」按钮与派单 Modal（受派人/标题/说明表单）、`assignOpen`/`assignForm`/`members` 状态、`Form`/`Input`/`Modal`/`Select`/`message`/`ApiError`/`projectApi` 依赖与 `busy` 状态；删任务表「操作」列（状态下拉）与 `changeTaskState`/`applyTaskState`（含槽位"收口它并开工"确认）；`load()` 去掉 `listTeam` 请求；任务卡顶部加只读说明一行 |
| web | 删 `web/src/lib/task-state.ts`、`tests/unit/web/task-state.test.ts` | 这两个文件是 S55 专为该下拉写的（`taskStateOptions`/`holdingTaskOf`），随入口一起删（4 条用例） |
| 未改 | `POST /api/projects/:pid/tasks`、`PATCH /api/projects/:pid/tasks/:tid` | 接口保留（脚本/人工干预仍可用）；服务端 `actor='user'` 的任意迁移（S55/D59）与"激活即唤醒"也保留，只是**面板不再使用** |
| docs | `prd`（**D61** + FR-08 核心句与补注 + 标记 D59 面板口径已被移除）、`ui.md` §5、`data-storage.md` §7、`agent-runtime.md` §6、`contract.md`、`README.md`、`plan/development.md`、`testing/plan.md`（规则 15 / 标记 S55 行 / 新增 S57 行）、验收阶段清单加 `s57` | 全链路回写 |

## 3. 关键决定

1. **先问再动**：两种读法会导致相反的实现（去掉入口 vs 修好入口），且"派单"这一项此前从未被报告过问题——问一句比猜一次便宜。
2. **只去掉"用户动作"，不动"平台能力"**：任务接口、状态机、单工槽位、激活唤醒全部保留。老板仍可经 API 干预（解卡、重开），只是不从面板点。
3. **留一行说明**：直接把"任务由角色驱动、面板只读、要干预用 API"写在任务卡上，省掉"派单按钮怎么没了"的来回。
4. **顺手删净死代码**：`task-state` 纯逻辑与其用例随入口删除；`WorkPanel` 的未使用导入/状态全部清掉（typecheck 的 `noUnusedLocals` 与 eslint 都会拦）。

## 4. 验证结果

| 项 | 结果 |
| --- | --- |
| 全量测试 | `npm test` **66 files / 413 tests 全绿**（S56 后为 67/417；删掉 `tests/unit/web/task-state.test.ts` 的 1 文件 4 条） |
| 覆盖率 / 依赖门禁 | `npm run coverage` **143/143**；`npm run ratchet` 违规 **0**（未删任何 `src/` 文件） |
| typecheck / eslint | 0 错误（清理了 `projectApi`/`run`/`setBusy` 三处未使用符号；`noUnusedLocals` + `no-unused-vars` 双门禁都拦到了） |
| 构建 | `npm run build` 通过；产物 `web/dist/assets/index-aBvsw35Y.js`（1,376.32 kB / gzip 431.13 kB）——比上一版小约 2.5 kB（删掉的表单/下拉逻辑） |
| ⚠️ 顺带记录一次**假红** | 首轮全量跑出现 `tests/integration/server/ws-gateway.test.ts`「上行 send」失败；**单独跑该文件两次均通过**，改到后台跑全量也通过——与本轮改动无关（该用例不 import `web/`），是并发负载下的既有抖动；同日早前也出现过一次 |
| 接口未受影响 | S55 的服务端用例（`actor='user'` 任意迁移、激活唤醒、槽位冲突带 `holding`）与 S55 的 HTTP 断言全绿 |
| **未覆盖** | 界面观感无法在本机自动化：**须用户点验** —— 「任务与产出物」任务卡只有「刷新」，表格无「操作」列，顶部出现只读说明；产出物/署名表不变 |
| 说明 | 与 S15~S56 的交付口径一致 |

## 5. 遗留

- **面板里没有任何"发起任务"的入口**：新项目要开工，得先和 PM（或某个角色）说一句让它派单；若某个项目没有 PM 或模板里没有派单能力，就只能走 API。若将来想给一个轻量入口，建议做成"对我说一句"的对话式发起（复用会话，而不是再放一个表单）。
- **服务端仍允许 `actor='user'` 任意迁移 + 激活唤醒**（S55/D59 的能力，现无界面消费者）：保留是为了脚本/人工干预；若要连 API 一起收紧（例如只允许 `todo → in_progress`、或要求角色身份），需要明确口径后再动（本轮未做）。
- **`workApi.createTask`/`setTaskState` 仍是前端客户端的一部分**（无调用方）：作为接口映射保留；若嫌死代码，可一并删（会让"脚本参考"少一处，未做）。
