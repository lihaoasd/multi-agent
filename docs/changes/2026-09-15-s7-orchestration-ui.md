# 修改记录 · S7 编排画布与前端完整化

> 类别：changes · 日期：2026-09-15 · 关联方案：[docs/plan/2026-09-15-s7-orchestration-ui.md](../plan/2026-09-15-s7-orchestration-ui.md) · 总计划：[development.md](../plan/development.md) §6
> 关联设计：[orchestration.md](../design/orchestration.md)、[ui.md](../design/ui.md) §3/§4/§5、[contract.md](../api/contract.md)

## 1. 需求 / 问题

S6 结束时任务能闭环，但**谁能派给谁没有约束**（`task_assign` 可派给任意实例，规则 22/23 无实现），前端也还停在"团队 + 会话（2 栏）+ 单列表"：没有编排画布、没有拓扑 2 栏/对话 3 栏、工作日志不能按 kind 过滤、右栏三列表缺失。

## 2. 改动范围

| 层 | 文件 | 说明 |
| --- | --- | --- |
| ports | `ports/orchestration.ts`（新增）、`ports/tokens.ts` | 编排图端口（Graph/Node/Edge/Store/Service）；tokens 29 → 30 |
| infra | `infra/file-store/orchestration-store.ts`（新增） | `projects/<pid>/orchestration.json` 原子写 + 单项目锁；损坏/缺失视为 `version=0` 空图 |
| application | `application/orchestration/orchestration-service.ts`（新增）、`application/task/task-service.ts` | 归一化（补节点/级联删边）、校验（自环/重复/跨项目）、乐观并发、广播、`outgoingOf`/`canDelegate`；任务创建接入出边约束 |
| server | `server/http-routes/orchestration.ts`（新增）、`server/app.ts` | `GET/PUT /api/projects/:pid/orchestration` |
| bootstrap | `bootstrap/{composition-root,main}.ts` | OrchestrationStore 端口 + OrchestrationService（注入 TaskService）|
| web | `web/src/api/orchestration.ts`、`web/src/pages/{TopologyPanel,RightColumn}.tsx`（新增）、`web/src/pages/{SessionPanel,ProjectModule}.tsx` | 自研 SVG 画布（拖拽/连线/删边/保存/暂停/打开会话）+ 右栏三列表；对话改 3 栏、工作日志折叠 + kind 过滤；项目页增「拓扑」页签（受控 activeKey）|
| docs | `docs/api/contract.md`、`docs/design/{orchestration,ui}.md`、`docs/plan/development.md` | 契约与设计回写 |
| tests | 2 个新文件 12 条 | 规则 22/23 |

## 3. 关键决定

1. **图即权限**：`creator !== 'user'` 的派单先查直接出边，缺失 → `ERR_ORCHESTRATION_EDGE` 且不建任务；用户派单不受限。
2. **读取即归一化、保存再校验**：`GET` 按团队补节点、级联删边（不落盘）；`PUT` 校验后 `version+1` 落盘并广播 `orchestration.updated`。
3. **乐观并发在服务层**：`expectedVersion` 不匹配 → `ERR_CONFLICT` + `detail.currentVersion`（画布提示刷新重试）。
4. **零依赖画布**：SVG 箭头 + 绝对定位卡片实现拖拽/连线/删边；不引入 React Flow（避免新增重型依赖），设计候选留 P1。
5. **右栏三列表组件化**：`RightColumn` 在拓扑页与对话页复用，订阅 WS（`task.updated`/`question.*`/`approval.*`/`agent.state`）自动刷新，可就地答复询问与裁决审批。
6. **工作日志折叠 + kind 过滤**：连续非对话事件合成一张 `Collapse`（默认折叠），过滤支持"仅看对话 / 显示全部事件（折叠）/ 指定 kind"。

## 4. 验证结果

| 验证项 | 结果 |
| --- | --- |
| 类型检查 | `npm run typecheck` 0 错误 |
| 测试 | **41 files / 278 tests 全通过**（S7 新增 2 文件 12 条） |
| 门禁 | `npm run lint` exit 0；`npm run ratchet` 越层违规 0；`npm run build` 成功 |
| 规则 22 | 演示：`GET` 8 节点 version=0 → `PUT`（pm_1→dev_1、dev_1→qa_1）→ v1；旧 version 再存 `ERR_CONFLICT`；自环 `ERR_ORCHESTRATION_INVALID`；HTTP 实测 **409/400** 与 `detail.currentVersion=1`；用例另覆盖重复边/跨项目节点/边端不在图中/实例移出后级联删边 |
| 规则 23 | 演示：`pm_1 → dev_1` 成功（todo）；`pm_1 → qa_1` → `ERR_ORCHESTRATION_EDGE`（提示"编排图中没有 pm_1 → qa_1 的委派边"），`qa_1` 任务数 0；`creator=user` 派给 `qa_1` 成功 |
| 前端 | `vite build` 成功：拓扑 2 栏（画布 + 右栏）、对话 3 栏、工作日志折叠、kind 过滤、右栏三列表就地处理询问/审批 |
| 文档 | contract/orchestration/ui/development 已回写；plan + changes 已落盘 |

## 5. 未做 / 回滚

- 未做（留 S8）：`POST .../agents/:iid/stop`（停止任务 + 未结算改动先结算）、未完成回合横幅三选与"停止生成"、托盘批量同意/信任开关 UI、`beforeunload` 未保存拦截；P1：活动边动画/自动布局/子图/编排模板、U12（下游主动向上游沟通）。
- 回滚：删除 `src/ports/orchestration.ts`、`src/infra/file-store/orchestration-store.ts`、`src/application/orchestration/`、`src/server/http-routes/orchestration.ts`、`web/src/api/orchestration.ts`、`web/src/pages/{TopologyPanel,RightColumn}.tsx` 与两个测试文件；还原 `task-service`（去掉出边约束与 `orchestration` 依赖）、`tokens`/`composition-root`/`main`/`app`/`SessionPanel`/`ProjectModule` 的改动；数据侧删除 `data/projects/<pid>/orchestration.json` 即彻底回退（图属可重建的展示+权限配置，删除后 `GET` 会按团队重新给出默认节点）。
