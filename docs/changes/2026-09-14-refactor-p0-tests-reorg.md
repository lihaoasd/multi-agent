# 修改记录 · 重构 P0-收尾：tests/ 按域分目录

> 日期：2026-09-14 · 阶段：P0 决策 D5 的落地（`docs/plan/2026-09-14-refactor-architecture.md`）
> 类型：纯组织结构调整（**无业务行为改动**；测试用例数与断言内容完全不变）

## 目标

用户确认的 D5：`tests/` 下 49 个扁平文件（`m8a~m9f` 命名）按域分到子目录——
"这正是'模块不好区分'的一部分"。

## 改动结果

```
tests/
├── helpers.ts            （保留在根：跨目录共享）
├── domain/       2 个     domain-agent-state / domain-command-policy
├── infra/        2 个     fs-utils / infra-store
├── application/  41 个    角色/会话/协作/工具/任务/会议/记忆/产出物/审批…
├── server/       2 个     api / static-web
└── web/          2 个     markdown / task-board-view
```

共移动 **49 个文件**，`tests/` 根目录只剩 `helpers.ts`。

## 关键实现：只改相对路径，断言一行不动

按本重构的硬约束（"257 用例断言不改，仅允许改 import 路径"），脚本只做两件事：
`renameSync` 移动文件 + 替换相对路径：

| 原路径 | 新路径 | 适用 |
| --- | --- | --- |
| `from '../src/...'` | `from '../../src/...'` | 子目录里的静态 import |
| `import('../src/...')` | `import('../../src/...')` | **动态 import**（首次漏掉，tsc 报 10+ 处后补） |
| `from './helpers.js'` | `from '../helpers.js'` | 共享测试工具 |
| `from '../web/...'` | `from '../../web/...'` | `tests/web/*.js`（首次漏掉，2 个 suite 加载失败后补） |

**两处漏改都是被工具直接抓出来的**：`tsc` 报静态/动态 import 未改，`vitest` 报 web 测试找不到模块。
这正说明"每步跑完整门禁"的价值——没有靠肉眼检查。

## 验证结果

| 项 | 结果 |
| --- | --- |
| `npx tsc -p tsconfig.json` | ✅ 无输出 |
| `npm run test`（全量） | ✅ **49 文件 / 315 用例**通过 |
| `npx eslint .` | ✅ 0 error / 11 warning |

**用例数 315 与重组前完全一致**——这是"只动路径、不动断言"的直接证据。

配置无需改动（本来就覆盖子目录）：
- `tsconfig.json`：`"include": ["src/**/*.ts", "tests/**/*.ts"]`
- `vitest.config.js`：`include: ['tests/**/*.test.{ts,js}']`

## 状态

至此，`docs/plan/2026-09-14-refactor-architecture.md` 里**除 P3g（最后 3 个超大文件）之外的全部阶段都已交付**：

| 阶段 | 状态 |
| --- | --- |
| P0 分层规则 + 特征化测试 | ✅ |
| P0-D5 tests/ 分目录 | ✅（本轮） |
| P1 存储抽象 + 15 store 迁移 | ✅ |
| P2 领域逻辑归位（domain 2→7 文件） | ✅ |
| P3 超大文件（9→3） | ⏳ 剩 `composition`/`meeting-service`/`loop-runner` |
| P4 路由拆分 + server 规则 promote | ✅ |
| P4b 工具注册表去全局化 | ⏸ 评估后延后（影响 ~20 个测试装配） |
| P6 文档对齐（loop 策略如实标注） | ✅ |
