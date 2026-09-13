# 修改记录 · 重构 P3e：`question-service` 归位（达标 ≤400 行）

> 日期：2026-09-14 · 阶段：P3e（`docs/plan/2026-09-14-refactor-architecture.md`）
> 类型：纯重构（**无业务行为改动**、无 REST/WS 契约变化）
> 上接：[p3d](2026-09-14-refactor-p3d.md)

## 目标

P3 剩余 4 个超标文件中，`question-service.ts`（448 行）最接近达标、且内部有清晰的
"纯规则 vs 编排"分界，因此本轮先做它。

## 改动范围

| 文件 | 行数 | 内容 |
| --- | --- | --- |
| `application/question/question-normalize.ts` | **新增** 192 | 提问的词汇（类型/常量）与全部归一化/渲染规则 |
| `application/question/question-service.ts` | **448 → 307** | 只剩"落盘、排队、广播"的编排；类型与规则改为 re-export |

搬走的 5 个纯函数 + 6 个类型：`pickedText` / `normalizeItemAnswer` / `normalizeAskItems` /
`normalizeRecord` / `normalizeQuestion`，以及 `QuestionKind|Answer|Item|Record` / `AskInput` / `AskItemInput`。

## 关键实现

### 1. 不引入 `shared/errors`，而是把"怎么抛错"作为参数

归一化规则里有 11 处校验失败，原本抛 `AppError(ErrorCodes.VALIDATION, msg)`。
若新模块直接 import `shared/errors`，就把它与错误码耦合；若改成抛 `Error`，**对外错误码会改变**——
那是行为变更，不是重构。

最终做法：新模块声明 `type Fail = (message: string) => never`，校验失败调用 `fail(...)`；
`QuestionService` 传入：

```ts
const fail = (message: string): never => {
  throw new AppError(ErrorCodes.VALIDATION, message)
}
```

**对外错误码与中文文案逐字不变**（`question-*` 四个测试文件 21 个用例保持通过）。

### 2. 我一度写成模块级注入并撤回（值得记下）

第一版我用了模块级 `setQuestionValidationFactory()` + 单例 `let validationFactory`。
写完即判断这是**隐式全局状态**：谁先调用决定错误类型，测试并发下还可能拿到默认的 `Error`。
改为"每次调用传 `fail`"——显式、无全局状态、无竞态。

### 3. 类型归位 + re-export 兼容

6 个类型定义整体搬到新模块（它们与归一化规则是同一套词汇），
`question-service.ts` 用 `export { ... } from './question-normalize.js'` 保持既有导入路径可用
（`composition.ts` 转出 `QuestionRecord` 给 REST 层）。

## 验证结果

| 项 | 结果 |
| --- | --- |
| `npx tsc -p tsconfig.json` | ✅ 无输出 |
| `npx vitest run` 四个 question/ask-user 测试文件 | ✅ 4 文件 / 21 用例通过 |
| `npm run test`（全量） | ✅ **49 文件 / 315 用例**通过 |
| `npx eslint .` | ✅ 0 error / 11 warning |

## 当前超标文件（4 → 3）

| 行数 | 文件 | 下一步 |
| --- | --- | --- |
| 692 | `application/composition.ts` | 装配体；需切依赖图，收益主要是行数 |
| 656 | `application/meeting/meeting-service.ts` | 可抽：讨论链编排（`respond` 约 78 行）、纪要渲染（`renderMinutes`）、`markJoined` |
| 636 | `application/agent-loop/loop-runner.ts` | `runTurnCore` 约 250 行是回合状态机本体，抽出后 runner 只剩几十行 |
| ~~422~~ | ~~`question-service.ts`~~ | ✅ 本轮达标（307） |

**P3 距离"所有 `.ts` ≤ 400 行"只剩 3 个文件**（P0 起点 9 个）。

## 下轮建议顺序

1. `meeting-service`：抽 `respond` 的成员回应编排 + `renderMinutes` 的纪要文本assembly（两块合计约 100 行）；
2. `loop-runner`：抽 `runTurnCore`（回合状态机）；
3. `composition.ts`：最后评估——它现在同时承担"装配 + 各域工厂 + server 门面导出"，
   拆分需要把依赖图切片（例如把"会话/工具域构造"独立成 `bootstrap/*.ts`）。
