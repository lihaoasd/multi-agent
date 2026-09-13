# 修改记录 · 重构收尾：旧代码/死代码审计与清理（2026-09-14）

> 类别：changes · 类型：**清理（无行为变更）**
> 触发：用户提问"查看是否有旧的不需要的代码"
> 关联：[重构方案](../plan/2026-09-14-refactor-architecture.md)、[交付总览](2026-09-14-refactor-summary.md)

## 一、结论先说

审计发现 **3 类**"旧的不需要的东西"，其中两类已清理，一类如实报告待决策：

| 类别 | 发现 | 处理 |
| --- | --- | --- |
| **陈旧构建产物** | `dist/` 是 **2026-09-13 重构前**的产物（含已删除的 `application/runtime-state.js`，无 `ports/`）；`npm start` 会跑重构前的旧代码 | ✅ 已删除并重新构建 |
| **死代码** | 18 处声明零消费者（死函数/死方法/死端口成员/死重复实现） | ✅ 已删除或接线为单一实现 |
| **配置与文档遗留** | 角色 YAML 列了 4 个未注册工具、`maxIterations` 从未被读取、历史 plan 文档仍写旧测试路径 | ⏸ 报告（见 §五，均已有文档说明或属历史记录） |

门禁：`tsc` 干净、`npm run test` **49 文件 / 315 用例**全绿、`eslint` **0 error / 11 warning**、`npm run build` 成功。

## 二、审计方法（可复现）

临时脚本（已清理，不入库）从五个角度扫描工作区：

1. **可达性**：以 `src/server/index.ts` + 全部测试 + `web/index.html` 引用的脚本为入口，沿 import 建图求可达集 → 找孤立模块。
2. **导出消费者**：解析 `import { … } from '…'`，逐个导出名判断"是否被**别的文件**从**导出它的模块**导入"。
3. **类成员**：抽出类内方法声明，统计 `.name(` 调用点。
4. **路由 ↔ 客户端**：把 `src/server/routes/*` 的 `/api/...` 路径与 `web/`、`tests/` 里的调用路径做归一化比对。
5. **文档路径**：把 `README.md` + `docs/design/` + `docs/plan/` 里出现的 `src/…` 路径逐个核对是否真实存在。

## 三、已清理（逐条可核对）

### 3.1 陈旧构建产物

```
dist/   ← 2026-09-13 产物：100 个文件，含 dist/application/runtime-state.js（重构中已删除的模块）
删除后 npm run build 重新生成 → dist/ports/ 存在、旧模块消失
```

`dist/` 在 `.gitignore` 内，因此**不影响提交内容**，但它会让本机 `npm start` 静默运行旧代码，属真实陷阱。

同时清理 `.test-tmp/` 下 **280 个**测试遗留临时目录（测试用例只建不清，同样在 `.gitignore` 内）。

### 3.2 删除的死代码（零消费者，且删除不影响任何测试）

| 文件 | 删除内容 | 依据 |
| --- | --- | --- |
| `src/shared/util/id.ts` | `isAllowedIdPrefix()` | 全仓零调用 |
| `src/infra/model/mock.ts` | `asChatText()` | 全仓零调用（`ChatMessage` 导入随之收窄） |
| `src/infra/model/gateway.ts` | `ModelGateway.complete()` | 全仓零调用（无 `.complete(` 调用点） |
| `src/domain/fsm/task-state.ts` | `isTerminalTaskState()` | 零调用；终态知识已由 `taskTransitionError` 承担 |
| `src/domain/fsm/approval-state.ts` | `isExpiredApproval()`、`ApprovalDecision`、`ApprovalLike` | 零引用（`expirePending` 直接写入状态，不再走判定函数） |
| `src/application/session/session-store.ts` | `ensureUserMeta()`、`reconcileLastSeq()` | 零调用；`buildUserSessionMeta` 仍被 `project-service` 使用故保留 |
| `src/application/artifact/file-owner-store.ts` | `mine()`、`others()` | 零调用；`composition.ts` 用已经读到的 `all` 就地过滤，比再读一次盘更优 |
| `src/application/meeting/invite-store.ts` | `joinedOf()` | 零调用；报到台账已改由 `meeting.memberJoined` 承担 |
| `src/ports/file-ops.ts` + `src/infra/store/local-file-ops.ts` | `existsDir()`、`listWithTypes()`（接口 + 实现） | 零调用。`listWithTypes` 的既定用途（"判断工作目录是否为空"）实际由 `project-service.detectWorkdirKind` 自己 `readdir` 实现 |

### 3.3 消除重复实现（domain 成为单一来源）

审计发现 P2 归位到 domain 的规则**同时**还以旧形态留在 service 里，导致 domain 那份变成死代码。选择**接线**而不是删除，让 P2 的归位真正生效：

| 位置 | 修改前 | 修改后 |
| --- | --- | --- |
| `meeting-service.activeCount()` | 内联字面量 `['proposed','open','blocked_waiting_user'].includes(...)` | 调用 domain 的 `isOccupyingMeetingState()`（该函数原为零调用的死代码） |
| `meeting-service` 呈现派生 | 自建 `MeetingWithDisplay` + `withDisplay` 重新实现一遍 | `MeetingWithDisplay = WithDisplay<MeetingRecord>`；`withDisplay` 薄委托 domain 的 `withMeetingDisplay()` |
| `meeting-service` 状态词汇 | 又声明一份 `export type MeetingState = 'queued' \| …`（零调用，与 domain 重复） | 删除 |
| `meeting-service` 兼容转出 | `export { meetingDisplayState, MEETING_ACTIVE_LABEL, MEETING_CLOSED_LABEL }`（无任何调用方 import） | 删除；相应导入项一并收窄 |

对象字面量字段顺序与取值逐字未变（`{...rec, displayState, waiting}`），**行为完全等价**。

### 3.4 顺带修正

- `src/domain/fsm/meeting-state.ts` 文件头曾写"待迁（P2 后续）：…流转守卫与占槽判定"——守卫在 P2b 已全部迁入本文件，属**过时注释**，已改为如实描述。
- `docs/plan/2026-09-14-refactor-architecture.md` 的 P1-1 任务行与 5.2 代码块仍写 `src/application/ports/storage.ts`，实际落地在 `src/ports/storage.ts`（P1a 实测记录里已解释原因），已就地标注修正，避免读者按错路径找文件。

## 四、验证结果

| 项 | 结果 |
| --- | --- |
| `npx tsc -p tsconfig.json` | ✅ 无输出 |
| `npm run test` | ✅ **49 文件 / 315 用例**通过（断言一行未改） |
| `npx eslint .` | ✅ 0 error / 11 warning（与清理前一致，未新增违规） |
| `npm run build` | ✅ 成功；`dist/ports/` 存在、旧 `runtime-state.js` 消失 |
| 可达性复检 | ✅ 孤立模块 **0**、无法解析的相对导入 **0** |
| 已删符号复检 | ✅ 全部 0 引用（残留命中仅存在于历史 change 记录的文字中） |

## 五、如实报告：**未**清理的三类遗留（各有理由）

| 项 | 现状 | 为什么不动 |
| --- | --- | --- |
| 角色 YAML 列了未注册工具：`meeting_advance` / `meeting_ask_user` / `fs_search` / `artifact_rollback`（8 个角色文件） | 角色白名单里有、注册表里没有 | **是已被文档如实披露的既有状态**（README 已知边界 + 角色详情弹窗按运行期口径如实暴露）。删改白名单会改变角色配置语义，不属"清理未使用代码" |
| 4 个角色 YAML 的 `loop.params.maxIterations` | 从未被任何代码读取 | 已由 P6 在 `agent-runtime.md` §3 标注为"**目标形态**、当前无消费者"；删掉会与该设计意图冲突 |
| `composition.ts` 转出的 `type QuestionRecord` / `type MeetingWithDisplay` | REST 层实际用推断类型，未显式 import 这两个别名 | 它们是**跨层门面契约**的一部分（注释已说明用途）；只删类型别名会让门面变得不对称，收益近零 |
| `infra/file-store/fs-utils.ts` 对 `ensureInside` / `isPathInside` 的 re-export | `src/` 内调用方已改为直接 import domain | **`tests/infra/fs-utils.test.ts` 仍从这里导入**；删除会违反"除 import 路径外不改测试"的硬约束，故保留 |
| 历史 `docs/plan/2026-09-*.md` 里的旧测试路径（如 `tests/tool-loop-m8g.test.ts`） | D5 分目录后应为 `tests/application/…` | 这些是**当轮的历史计划记录**，不是当前状态文档；批量改写历史记录的收益低于其失真风险 |

## 六、一条工具层面的教训（防复发）

本轮我自己写的"符号使用计数"脚本，正则用了 `(?<![\w$.])name`——**lookbehind 里排除了 `.`**，于是 `service.method(` 这类调用**全部漏计**，
把 `MeetingService.hasActiveMeeting` 误判为死代码并删除（它被 `tests/application/meeting-queue-m8z.test.ts` 使用）。

- **发现方式**：`tsc` 立刻报 `Property 'hasActiveMeeting' does not exist`，随即恢复该方法。
- **结论**：凡是"删除代码"的判断，**必须以编译器/测试为最终裁决**，脚本只用来缩小候选范围。
  本记录中所有删除项都在 `tsc` + 315 用例下复验通过；`tsc` 覆盖 `tests/`，因此测试对成员的引用不会被漏判。
