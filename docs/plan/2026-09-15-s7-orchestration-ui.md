# 开发方案 · S7 编排画布与前端完整化

> 类别：plan · 状态：已完成（2026-09-15）· 类型：**实现** · 总计划：[development.md](development.md) §6 · 执行结果见 [修改记录](../changes/2026-09-15-s7-orchestration-ui.md)
> 关联：[orchestration.md](../design/orchestration.md)、[ui.md](../design/ui.md) §3/§4/§5、[data-storage.md](../design/data-storage.md) §7、[contract.md](../api/contract.md)

## 1. 目标与范围

把"团队协作"的两件事补齐：**谁能派单给谁**由项目级编排图决定（Agent 只能沿出边委派，用户不受限），以及把项目页做成设计里的**拓扑 2 栏 / 对话 3 栏**工作台（画布、右栏三列表、工作日志折叠与 kind 过滤）。

| 在范围内 | 不在范围内（后续阶段） |
| --- | --- |
| `orchestration.json` + `GET/PUT /api/projects/:pid/orchestration`（全量保存 + `version` 乐观并发 + 自环/重复边/跨项目节点校验） | 活动边流转动画、甘特/进度条、自动布局算法、子图/分组、编排模板（P1） |
| `task_assign` 的**出边约束**（`ERR_ORCHESTRATION_EDGE`，越边不建任务；用户不受限） | 多计划/多图（U12：下游主动向上游沟通） |
| 项目页「拓扑」页签：自研轻量 SVG 画布（拖拽、连线、删边、保存、暂停/继续、打开会话）+ 右栏三列表 | React Flow 选型（设计候选；本轮零依赖实现同等编辑语义） |
| 对话页 3 栏：会话切换 + 会话流（工作日志折叠 + kind 过滤）+ 右栏三列表 | 未完成回合横幅三选与"停止生成"（S8） |
| 右栏三列表（任务/询问/审批）就地处理 + WS 实时刷新 | 托盘批量同意/信任开关（D17-④，S8） |

## 2. 关键决定

1. **图即权限**：边 = "可以创建/委派任务"的有向关系；`TaskService.create` 在 `creator !== 'user'` 时先查直接出边，缺失 → `ERR_ORCHESTRATION_EDGE` 且**不建任务**（铁律 2/4）。汇报沿反向是系统行为，不要求反向边。
2. **读取即归一化（不落盘）**：`GET` 按当前团队补齐缺失节点（网格默认位）、级联删除已移除实例的节点与边；`PUT` 再校验一次——这样"删成员/停用实例"不需要额外的图迁移任务。
3. **乐观并发在服务层**：`expectedVersion !== current.version` → `ERR_CONFLICT`（`detail.currentVersion`），保存成功 `version+1` 并广播 `orchestration.updated`；保存是单项目串行锁内的全量原子写。
4. **零依赖画布**：不引入 React Flow（避免新增重型依赖），用 SVG 画箭头 + 绝对定位卡片实现拖拽移动、连线模式点击两端建边、选中/删除边；保存语义与设计一致（全量 + version + 冲突提示刷新）。
5. **右栏三列表抽成组件**复用于拓扑页与对话页（ui.md §5"两页共用"），并订阅 WS（`task.updated`/`question.*`/`approval.*`/`agent.state`）实时刷新。
6. **工作日志折叠**：会话流按"连续非对话事件"分组成一张 `Collapse`（默认折叠，标签显示条数与 kind 集合）；`kindFilter` 支持 `仅看对话 / 显示全部事件（折叠）/ 指定 kind`。

## 3. 交付物

| 步骤 | 交付物 |
| --- | --- |
| S7.1 端口 | `ports/orchestration.ts`（Graph/Node/Edge/Store/Service）；tokens 29 → 30 |
| S7.2 infra | `infra/file-store/orchestration-store.ts`（`orchestration.json` 原子写 + 单项目锁；损坏视为空图） |
| S7.3 application | `application/orchestration/orchestration-service.ts`（归一化、校验、乐观并发、广播、`outgoingOf`/`canDelegate`）；`task-service` 接入出边约束 |
| S7.4 server | `http-routes/orchestration.ts`（GET/PUT）+ `app.ts` 接入 |
| S7.5 装配 | `composition-root.ts`：OrchestrationStore 端口 + OrchestrationService（注入 TaskService）|
| S7.6 前端 | `api/orchestration.ts`、`pages/TopologyPanel.tsx`（画布）、`pages/RightColumn.tsx`（右栏三列表）、`SessionPanel` 3 栏 + 工作日志折叠 + kind 过滤、`ProjectModule` 增「拓扑」页签（受控 activeKey，画布可跳会话）|
| S7.7 测试 | `unit/application/orchestration-service`(8)、`integration/server/orchestration-api`(4) = 12 条（规则 22/23）|

## 4. 验证方式与结果

| 验证项 | 方式 | 结果 |
| --- | --- | --- |
| 类型检查 / 门禁 | `typecheck` / `lint` / `ratchet` / `build` | 0 错误 / exit 0 / 越层违规 0 / vite 构建成功 |
| 测试 | `npm run test` | **41 files / 278 tests 全通过**（S7 新增 2 文件 12 条） |
| 规则 22 保存与校验 | 演示 + 用例 + HTTP | `GET` 自动补齐 8 个节点（version=0）；`PUT` 存 2 条边 → v1 并广播；旧 version → **409 ERR_CONFLICT**（`detail.currentVersion=1`）；自环/重复边/跨项目节点 → **400 ERR_ORCHESTRATION_INVALID**；缺 version → 400 |
| 规则 23 边约束 | 演示 + 用例 + HTTP | `pm_1 → dev_1` 沿出边派单成功（todo + 通知）；`pm_1 → qa_1` 越边 → `ERR_ORCHESTRATION_EDGE`，`qa_1` 任务数 **0**（不建任务）；`creator=user` 可派给任意实例 |
| 归一化 | 用例 | 实例移出团队后读取即级联删除其节点与边；`outgoingOf/canDelegate` 与边一致 |
| 前端 | `vite build` | 拓扑 2 栏（画布 + 右栏）/ 对话 3 栏、工作日志折叠、kind 过滤、右栏三列表可处理询问与审批 |

## 5. 不做与遗留

- 设计候选的 React Flow 未引入（零依赖自研画布，语义一致）；P1 的动画/自动布局/子图不做。
- `POST .../agents/:iid/stop`（停止任务、未结算改动先结算）与未完成回合横幅三选留 S8。
- 画布"未保存改动"仅在页面内提示（`未保存` 标记 + 保存按钮态），未接浏览器 beforeunload 拦截。
