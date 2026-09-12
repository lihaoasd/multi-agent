# 2026-09-12 任务面板改三列 + 右栏只显示进行中/待领取

## 需求/问题

用户："任务面板栏分三列显示，任务栏只显示进行中和待领取的任务"

- 面板此前按 5 个状态各一列（待领取/进行中/受阻/已完成/已终止），列数随数据变化、布局不稳；
- 右栏「任务栏」列出全部任务（含已完成/终止），有效信息被历史任务淹没。

## 改动范围

### 一、抽出纯函数模块 `web/task-board.js`（可单测）

- `ACTIVE_STATES = ['todo','in_progress']` + `activeTasks(tasks)`：**右栏只显示活跃任务**，进行中优先、组内按更新时间倒序。
- `BOARD_COLUMNS`（**固定三列**）+ `groupBoardTasks(tasks)`：
  1. 待领取（已发布）
  2. 进行中
  3. **已结束（完成 · 受阻 · 终止）**——列内顺序 受阻 → 已完成 → 已终止（受阻需要关注，排最前），
     每张卡片仍显示自己的**准确状态徽标**。
  - 空任务也返回 3 个空列（布局稳定）。
- `countByState(tasks)`：面板顶部统计。

### 二、页面接线（`web/app.js`、`web/style.css`）

- `renderTasks()`：右栏改用 `activeTasks()`；徽标仍显示 `N 待领取 / M 进行中`；条目上限 12；
  若存在历史任务，底部提示「另有 N 条已完成/受阻/终止 → 打开面板查看」。
- `renderTaskBoard()`：改用 `groupBoardTasks()` 渲染三列；第三列卡片追加状态徽标；空列显示「（暂无）」。
- `.board-body` 由 flex 换为 **CSS Grid `repeat(3, minmax(0,1fr))`**（窄屏 <760px 退化为单列），
  列容器统一 `min-height` 保证三列对齐。

### 三、测试

- 新增 `tests/task-board-view.test.js`（5 例，直接 import 真实模块）：
  - 右栏过滤掉 done/blocked/terminated 且进行中在前、组内按时间倒序、空输入安全；
  - 列定义恰为三列；第三列收纳完成/受阻/终止并按 受阻→完成→终止 排序；空任务返回 3 个空列；`countByState` 计数。
- `tests/static-web-m8k.test.ts`：任务栏用例补断言——`app.js` 引用了 `task-board.js`/`activeTasks`/`groupBoardTasks`，
  且 `GET /task-board.js` 可静态访问（接线断了会被测出）。

## 验证结果

- `node --check web/app.js` → 0；`npx tsc -p tsconfig.json` → 0；`npx eslint .` → 0
- `npx vitest run --pool=threads` → **28 文件 / 170 用例全绿**

## 语义/取舍

- 三列中的第三列**合并**了已完成、受阻、已终止（用徽标区分），而不是按状态各开一列——这样列数固定为三；
  若希望"第三列只显示已完成、隐藏受阻与终止"，改 `BOARD_COLUMNS` 一处即可。
- 右栏只做**活跃任务**视图，历史任务统一在面板里看（数据与接口未变，仍是 `GET /tasks` 全量）。
- 未做浏览器人工目视验收（布局改动通过纯函数单测 + 静态接线断言验证）。
