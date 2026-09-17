# S29 方案：「提示词预览」点击无反应的缺陷修复（弹窗挂载到两个分支）

> 日期：2026-09-16　类型：缺陷修复（用户报告："提示词预览，点击没反应"）　真源：`design/ui.md` §2.2/§3
> 关联：`docs/changes/2026-09-16-s29-preview-modal-branch.md`、`docs/plan/development.md`

## 1 现象

用户报告：项目详情页「团队与配置」标签里点 **「提示词预览」**，**界面没有任何反应**（不弹窗、也不报错）。

## 2 根因（组件挂载位置与触发入口不在同一个分支）

`web/src/pages/ProjectModule.tsx` 里组件有**两个互斥的顶层 `return`**：

| 分支 | 位置 | 内容 |
| --- | --- | --- |
| 项目**详情**页 | `if (current !== null) { return (…) }` | 标题栏 + Tabs（拓扑/团队与配置/…）；**「提示词预览」按钮在这里**（团队与配置表格的操作列） |
| 项目**列表**页 | 末尾的 `return (…)` | 项目列表表格 + 创建向导 |

而**预览弹窗的 JSX 只写在「项目列表」那个 return 里**（原第 563~581 行）。

于是详情页点击按钮的执行链是：`showPreview()` → `promptPreviewApi.preview()` **成功** → `setPreview(view)` → **没有任何组件消费这个 state**（弹窗在另一个分支里，根本没挂载）→ 界面毫无变化 = 用户看到的"点击没反应"。

> 这类缺陷的迷惑性在于：**接口是好的、状态也更新了**，只是"渲染它的那棵树"不在当前分支，所以既没有 UI 也没有报错。

## 3 影响面

| 面 | 位置 | 现状 |
| --- | --- | --- |
| 前端 | `web/src/pages/ProjectModule.tsx` | 预览弹窗只在列表分支；按钮只在详情分支 |
| 前端（同页） | 同文件其它浮层 | `Drawer`（覆盖配置）在详情分支 ✓；创建向导 `Modal` 与 `DirectoryPicker` 在列表分支 ✓ —— 只有预览弹窗错位 |
| 前端（其它页） | `AgentModule`/`ToolsModule`/`ModelModule`/`WorkPanel` | 已审计：Modal/Drawer 都写在同一 return 里，**无同类问题** |
| 后端 | `GET /api/projects/:pid/agents/:iid/system-prompt` | **正常**（本轮不改） |

## 4 关键决定

1. **把弹窗抽成组件 `PromptPreviewModal`，在两个分支各挂一次**：组件定义唯一（`preview` 为 `null` 时 `open=false`，不显示），既修好详情页，也不破坏列表页（列表页其实没有触发入口，但保留挂载成本为零、语义一致）。
   - 备选是把两个 `return` 合成一个（`const body = current !== null ? … : …` 再统一 return）——那会重排 670 行文件的大段 JSX，diff 噪音远大于收益，**不做**。
2. **顺手审计同类风险**：Modal/Drawer 是否都在"能触发它的那棵树"里（本页与其它页都查了一遍，只有这一处错位）。
3. **不改交互与接口**：弹窗内容、宽度、标题、数据来源全部照旧；`preview === null` 时不渲染内容。
4. **记录这类缺陷的判别方法**（写进修改记录）：组件有两个顶层 `return` 时，任何"点击无反应但无报错"的浮层，先查它挂在哪个分支。

## 5 实现步骤

- `web/src/pages/ProjectModule.tsx`
  - 新增局部组件 `PromptPreviewModal({ preview, onClose })`（把原弹窗 JSX 原样搬进来，含 `open={preview !== null}`）。
  - 详情分支（`</Drawer>` 之后）挂一次；列表分支（创建向导 `Modal` 之前）挂一次。
  - 删除列表分支里原来的内联弹窗 JSX。
- 文档回写：`docs/changes/2026-09-16-s29-preview-modal-branch.md`；`README.md`/`plan/development.md`/`testing/plan.md` 阶段索引与验收记录；验收阶段清单加 `s29`。

## 6 验证方式

| 层 | 手段 |
| --- | --- |
| 类型/规范 | `npm run typecheck`（src + web）、`npx eslint .` |
| 构建 | `npm run build`（产物含 `系统提示词预览` 文案） |
| 回归 | `npm test` 全绿 + `npm run coverage` + `npm run ratchet` |
| 活体 | `GET /assets/<新产物>.js` 200 |
| **交互验证（用户）** | 刷新后：项目详情 →「团队与配置」→ 任一行「提示词预览」应弹出预览弹窗；列表页「打开」项目不受影响 |
| 说明 | 无 DOM 测试 → 这类"浮层没挂载"的缺陷只能靠点验；DOM 级测试环境已在 S23/S27/S28 记为遗留项 |

## 7 风险

| 风险 | 对策 |
| --- | --- |
| 未来再加分支时同类问题复发 | 修改记录写明判别方法；`PromptPreviewModal` 抽成组件后"挂在哪"变得显式、易查 |
| 两个分支各挂一次造成重复渲染 | 同一时刻只有一个分支存在（互斥 `return`），且 `preview === null` 时弹窗 `open=false` |
| 用户其实还想要"Agent 模块也能预览模板提示词" | 本轮只修缺陷，不扩范围；如需在 Agent 模块加预览入口，属新需求（`promptPreviewApi` 需要实例维度，模板维度需后端支持） |
