# 开发方案 · S2 存储底座与项目 / 团队

> 类别：plan · 状态：已完成（2026-09-15）· 类型：**实现** · 总计划：[development.md](development.md) §6 · 执行结果见 [修改记录](../changes/2026-09-15-s2-project-team.md)
> 关联：[data-storage.md](../design/data-storage.md)（§2 布局、§3 project.json）、[contract.md](../api/contract.md)（项目/团队/目录浏览器）、[agent-templates.md](../design/agent-templates.md) §4（快照口径）、[abstraction.md](../design/abstraction.md) §4.3/§4.4

## 1. 目标与范围

让"项目"真正存在：项目管理（列表/创建向导/改名/删除）+ 团队实例（快照、增删停启）+ **实例层三项配置覆盖**（S1 推迟的那半），并补齐读改写所需的**串行锁**与"用户级目录浏览器"。

| 在范围内 | 不在范围内（后续阶段） |
| --- | --- |
| `LockManager`（KeyedLock）、`ProjectStore`（project.json 真源 + index.json 投影）、目录浏览器与工作目录校验 | 会话与消息（S3）、单工调度与 WS 网关（S3） |
| 项目 CRUD + 创建向导（选目录 / 勾角色 / 默认 8 内置模板） | 拓扑画布（S7）、任务/询问/审批（S6） |
| 团队实例：快照（D16-⑤）、每模板 1 实例（D14-3）、停用=保留数据（D14-9）、三项覆盖 + `configVersion` | 实例删除（物理删）与多实例（D14-3 后续版本） |
| `EffectiveAgentConfig` 解析链（实例覆盖 → 模板快照 → 平台默认）与 `GET .../agents` 状态投影（S2 阶段恒为 idle） | dispatcher 的真实状态（S3）、workdir watch（用到时再加） |
| 前端「项目」模块：列表 / 创建向导 / 目录浏览 / 团队与覆盖配置 | 项目页拓扑与对话导航（S3/S7） |

## 2. 关键决定

1. **索引是投影，不是真源**：`data/projects/<id>/project.json` 为唯一真源，`index.json` 每次 `list` 重建（可丢可重建）。旧实现遗留的非法 `project.json`（如 `proj_97i6x16sx61f`）在扫描时被跳过而不报错。
2. **读改写串行**：`ProjectStore.update` 内部走 `KeyedLock`（按 projectId），并发 10 次追加实测不丢更新；锁实现零依赖、进程内有效，P2 多进程时换实现即可（端口不变）。
3. **快照进实例**（D16-⑤）：实例保存 `snapshot`（提示词/默认模型/默认 loop/工具包/工具/产出类型/审批规则）+ 覆盖字段 `prompt`/`model`/`loop`（`null` = 跟随快照）+ `configVersion`。有效配置解析为 `覆盖 → 快照 → 平台默认模型`，**不静默挑模型**（都没有则为 `null`）。
4. **工作目录校验在"用户级 API"里做**：`/api/fs/browse` 与 `/api/fs/inspect` 绕过 Agent 沙箱（M8 定稿），但创建项目时仍校验：存在、是目录、**可写**、且**不在平台数据目录内**（前缀判定大小写不敏感、兼容两种分隔符）。
5. **停用不是删除**（D14-9）：`DELETE /api/projects/:pid/team/:iid` = 停用（保留会话/记忆，可 `POST .../enable` 恢复）；重复停用/启用返回 `ERR_CONFLICT`，不做静默幂等。
6. **客户端错误不能报成 500**：本轮实测发现两处 —— ① 不支持的 content-type（415）与空 JSON body（`FST_ERR_CTP_EMPTY_JSON_BODY`）被统一映射成 `ERR_INTERNAL`；② 无 body 的 POST（带 JSON content-type）直接 500。修法：4xx `statusCode` → 4xx 语义（404 → `ERR_NOT_FOUND`，其余 → `ERR_VALIDATION`），并为 `application/json` 注册"空 body 视为 `{}`"的解析器。

## 3. 交付物

| 步骤 | 交付物 |
| --- | --- |
| S2.1 端口 | `ports/lock.ts`、`ports/project.ts`（`ProjectMeta`/`RoleInstance`/`RoleInstanceSnapshot`/`ProjectStore`）、`ports/fs-browse.ts`；`ports/tokens.ts` 增 3 个 Token（共 15） |
| S2.2 infra 存储 | `infra/file-store/project-store.ts`（项目目录结构、投影重建、锁、解析校验）、`infra/lock/keyed-lock.ts` |
| S2.3 infra 目录 | `infra/fs/directory-browser.ts`（盘符列表/隐藏项过滤/系统目录过滤/仓库嗅探/工作目录检查） |
| S2.4 application | `application/project/service.ts`（创建向导校验 + 快照）、`application/team/{effective-config,team-service}.ts`（实例 CRUD/覆盖/停启/有效配置） |
| S2.5 server | `server/http-routes/projects.ts`（项目/团队/`agents` 投影/`fs/browse`/`fs/inspect`）；`app.ts` 接入；`errors.ts` 4xx 映射修正 + 空 body 解析器 |
| S2.6 装配 | `composition-root.ts`：注册 3 个新端口 + 装配 `ProjectService`/`TeamService`（含 `platformDataRoot` 绝对路径）；`main.ts`/测试 helper 传入新服务 |
| S2.7 前端 | `web/src/api/projects.ts`、`web/src/pages/ProjectModule.tsx`（列表、四步向导、目录浏览弹窗、团队表 + 覆盖配置抽屉 + 恢复快照 + 停启用）；`App.tsx` 默认进项目模块 |
| S2.8 测试 | 新增 6 个文件 39 条：`keyed-lock`(4)、`project-store`(9)、`directory-browser`(5)、`effective-config`(4)、`server/errors`(4)、`projects-api`(13) |

## 4. 验证方式与结果

| 验证项 | 方式 | 结果 |
| --- | --- | --- |
| 类型检查 | `tsc`（服务端 + 前端） | 0 错误 |
| 测试 | `vitest run` | **18 files / 122 tests 全通过**（S2 新增 39 条） |
| 门禁 | `eslint .` + ratchet | exit 0；越层违规 0 |
| 真实服务验收（规则 8 + FR-01/02） | 起服务（3100）后 curl/PowerShell 走查 | 目录浏览与工作目录检查 ✓；创建项目 8 成员 + 快照落盘 ✓；工作目录在 `data/` 内被拒 400 ✓；重复加同角色 409 ✓；停用→重复停用 409→启用 ✓；三项覆盖 `configVersion=2`、`overrides=[prompt,model,loop]` ✓；loop 越界 400 ✓；清空覆盖回到快照 ✓；`agents` 投影 8 条 idle ✓；删除项目只删运行时数据 ✓ |
| 落盘结构 | 检查 `data/projects/<id>/` | `project.json` + `sessions/`、`memories/`、`artifact-versions/` + `tasks/questions/approvals/artifacts/file-owners.jsonl` 全部就位 |
| 中文与 UTF-8 | curl 发 UTF-8 原文建项目 | `name=中文项目名验证`、`displayName=后端开发` 正确往返 |
| 客户端错误映射 | 带不支持 content-type / 空 JSON body 的 POST | 400 `ERR_VALIDATION`（此前为 500）；空 body 的 enable 200 |
| 前端 | `vite build` + `GET /` | 构建成功；页面默认进入「项目」模块 |

## 5. 不做与遗留

- `workdir watch`（工作目录外部变更提示）未实现：用到时（S6 产出物/编辑冲突）再加，端口不变。
- 实例物理删除、同角色多实例（`dev_1`/`dev_2`）属后续版本（D14-3）；当前 `DELETE` 只停用。
- `GET .../agents` 的 `state` 恒为 `idle`：真实状态由 dispatcher 提供（S3）。
- 项目页的拓扑/对话导航、任务与询问列表（S3/S6/S7）未做，前端在本轮只到"团队与配置"。
- 端口 3000 仍被旧的 14:29 实例占用（非本轮），验收统一 3100。
