# 修改记录 · S2 存储底座与项目 / 团队（2026-09-15）

> 类别：changes · 类型：**实现** · 方案：[docs/plan/2026-09-15-s2-project-team.md](../plan/2026-09-15-s2-project-team.md) · 总计划：[development.md](../plan/development.md) §6
> 需求来源：用户"开始全部开发"；本轮落地 FR-01（项目管理）、FR-02（角色抽象与实例化）与 D14-3/D14-9/D16-⑤/D20-⑦ 的实例层配置

## 1. 交付内容

| 层 | 新增/修改文件 |
| --- | --- |
| 端口 | `ports/lock.ts`、`ports/project.ts`、`ports/fs-browse.ts`；`ports/tokens.ts`（12 → 15 个 Token：LockManager / DirectoryBrowser / ProjectStore） |
| infra 存储 | `infra/file-store/project-store.ts`（project.json 真源 + index.json 投影 + 锁 + 严格解析）、`infra/lock/keyed-lock.ts` |
| infra 目录 | `infra/fs/directory-browser.ts`（盘符/隐藏与系统目录过滤/仓库嗅探/工作目录检查） |
| application | `application/project/service.ts`、`application/team/effective-config.ts`、`application/team/team-service.ts` |
| server | `server/http-routes/projects.ts`（新增）；`server/errors.ts`（4xx 映射修正）、`server/app.ts`（注册项目路由 + 空 body JSON 解析器） |
| bootstrap | `composition-root.ts`（3 个新端口 + `ProjectService`/`TeamService` 装配 + `platformDataRoot`）、`main.ts` |
| 前端 | `web/src/api/projects.ts`、`web/src/pages/ProjectModule.tsx`；`web/src/App.tsx`（默认进项目模块、项目菜单启用） |
| 测试 | `tests/unit/{infra/keyed-lock,infra/project-store,infra/directory-browser,application/effective-config,server/errors}.test.ts`、`tests/integration/server/projects-api.test.ts`、`tests/helpers-server.ts`（服务注入） |

## 2. 关键决定（可推翻）

1. **project.json 是真源、index.json 是投影**：`list()` 扫描各项目 `project.json` 并重建索引；结构非法的遗留项目（如旧实现的 `proj_97i6x16sx61f`）被跳过而非让列表整体失败。
2. **锁粒度 = 项目**：`ProjectStore.update/remove/create` 都在 `project:<id>` 锁内完成"读→改→写→重建索引"，并发 10 次追加实测不丢更新；锁端口化，P2 换文件锁不改调用方。
3. **实例快照 + 覆盖双轨**：`snapshot`（创建时从模板捕获）与 `prompt`/`model`/`loop` 覆盖字段分离；`PATCH` 传 `null` 表示清除覆盖回到快照；仅覆盖变化时 `configVersion+1`（改显示名/停用不递增）。
4. **有效配置解析链**：`实例覆盖 → 模板快照 → 平台默认模型`；三级都没有时为 `null`，由调用方（S4 loop）报 `ERR_MODEL`，**不静默挑模型**。
5. **工作目录校验**：用户级 API 绕过 Agent 沙箱，但创建项目仍要求"存在 + 目录 + 可写 + 不在平台数据目录内"；`WorkdirInspection.path` 返回规范化绝对路径，使 application 层无需依赖 `node:path` 即可做前缀判定。
6. **停用 ≠ 删除**：`DELETE .../team/:iid` 停用并保留数据（可重新启用），重复操作 `ERR_CONFLICT`（无静默幂等）。
7. **修正"客户端错误报成 500"**（本轮实测发现，两处）：
   - 不支持的 content-type（415）与空 JSON body（`FST_ERR_CTP_EMPTY_JSON_BODY`）此前被映射为 `ERR_INTERNAL` → 现按 4xx `statusCode` 映射为 `ERR_VALIDATION`（404 → `ERR_NOT_FOUND`）；
   - 无 body 的 POST（带 `application/json`）此前直接 500 → 现注册"空 body 视为 `{}`"的 JSON 解析器，`POST .../enable` 这类无参数接口可正常调用。

## 3. 验证结果

| 验证项 | 结果 |
| --- | --- |
| 类型检查（服务端 + 前端） | 0 错误 |
| 测试 | **18 files / 122 tests 全通过**（S2 新增 39 条：锁 4、项目存储 9、目录浏览器 5、有效配置 4、错误映射 4、项目 API 13） |
| 门禁 | `eslint .` exit 0；ratchet 越层违规 0 处（基线 0） |
| 真实服务验收 | 目录浏览/检查 ✓；创建项目（8 成员 + 快照）✓；工作目录在 `data/` 内 → 400 ✓；重复加同角色 → 409 ✓；停用 → 重复停用 409 → 启用 ✓；三项覆盖（`configVersion=2`、`overrides=prompt,model,loop`）✓；loop 越界 → 400 ✓；清空覆盖回快照 ✓；`agents` 投影 8 条 idle ✓；删除项目后列表为空且工作目录未受影响 ✓ |
| 落盘结构 | `data/projects/<id>/` 下 `project.json` + `sessions/`、`memories/`、`artifact-versions/` + 5 个 JSONL 记录文件齐备 |
| UTF-8 | curl 原文建项目 `name=中文项目名验证`、覆盖 `displayName=后端开发` 均正确往返 |
| 客户端错误映射 | 不支持 content-type → 400 `ERR_VALIDATION`；空 body + JSON 的 enable → 200（此前 500） |
| 前端 | `vite build` 成功；默认进入「项目」模块；创建向导含目录浏览与角色勾选 |

## 4. 未做 / 遗留

- `workdir watch`、实例物理删除、同角色多实例、`agents` 真实状态（dispatcher）按计划留后续阶段。
- 前端项目详情页只到"团队与实例配置"；拓扑画布、会话、任务/询问列表分别在 S7/S3/S6。
- 本轮未做旧项目数据迁移：旧实现遗留的 `data/projects/proj_97i6x16sx61f/project.json` 不符合新 schema，列表会跳过它（不报错、不删除）；如需清理由用户手动删除。
- 端口 3000 仍被 14:29 启动的旧实例占用（非本轮），验收统一用 3100。

## 5. 回滚

```bash
git rm src/ports/{lock,project,fs-browse}.ts src/infra/lock/keyed-lock.ts \
  src/infra/file-store/project-store.ts src/infra/fs/directory-browser.ts \
  src/application/project src/application/team/{effective-config,team-service}.ts \
  src/server/http-routes/projects.ts web/src/api/projects.ts web/src/pages/ProjectModule.tsx \
  tests/unit/infra/{keyed-lock,project-store,directory-browser}.test.ts \
  tests/unit/application/effective-config.test.ts tests/unit/server/errors.test.ts \
  tests/integration/server/projects-api.test.ts
git checkout HEAD -- src/ports/tokens.ts src/server/{app,errors}.ts src/bootstrap/composition-root.ts \
  src/bootstrap/main.ts web/src/App.tsx tests/helpers-server.ts docs/api/contract.md \
  docs/design/data-storage.md docs/plan/development.md
```
