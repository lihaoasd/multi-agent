# 2026-09-09 创建项目向导：角色「全选」

> 类别：changes · 需求来源：用户「创建项目可全选角色」

## 需求/问题

创建项目弹窗里角色是一个个勾选，8 个内置角色要逐个点；希望有「全选」一次勾完。

## 改动范围

- `web/index.html`：角色 fieldset 的 legend 增加「全选」复选框（`#w-role-all`）与已选计数（`#w-role-count`；
  角色列表改为独立容器 `#w-roles-list`，避免重渲染时把全选控件一起清掉）。
- `web/app.js`：
  - 新增 `syncRoleAll()`：同步全选勾选态（部分选中时半选 `indeterminate`）、禁用态与「已选 N/M」计数；
  - 角色渲染到 `#w-roles-list`，每个角色复选框 `change` 时回写全选态（默认仍勾选 pm/product/dev）；
  - 「全选」`change`：一次勾选/取消全部角色；
  - 创建时收集改为 `#w-roles-list input:checked`（不会把全选复选框误当成角色）。
- `web/style.css`：`.role-all`（legend 内联全选样式）、`.role-list`（角色网格换行）。

## 验证

- `npx eslint .`、`npx tsc -p tsconfig.json` 通过；`npx vitest run --pool=threads` 116 用例全绿（本次仅前端静态页）。
- 起服务（dist + 静态 `web/`）实测抓取资源：`/` 含 `w-role-all`/`w-roles-list`/`w-role-count`，
  `/app.js` 含全选监听与 `#w-roles-list input:checked` 收集逻辑，`/style.css` 含 `.role-all`/`.role-list`；
  grep 确认无遗留的旧选择器 `#w-roles input`。
- 局限（说明）：前端为无构建 ESM 静态页、无浏览器 e2e 用例，交互为静态一致性 + 代码审查验证，未做真实点击回归。

## 遗留（说明）

- 未加"反选/按分类全选"等增强；角色默认勾选仍为 pm/product/dev（可用全选一键改全部）。
