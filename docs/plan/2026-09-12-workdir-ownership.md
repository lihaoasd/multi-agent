# 开发方案：产出全部落到项目目录 + 署名 + 归属锁（取消私有工作区）· 2026-09-12

> 需求来源（用户口述）："修改工作空间，所有角色的产出都放到项目目录里，需要标记自己的姓名，
> 自己在哪修改自己的产出物，其他人不能动"
> 用户确认：**A. 取消私有区（ws://），所有角色直接在项目目录产出**；**B. 他人文件只能只读 + 新建文件（不做转交）**。

## 1. 现状与问题

| 现状 | 问题 |
| --- | --- |
| 角色先在 `ws://` 私有区写，再 `artifact_submit` 拷进项目目录 | 产出默认不在项目目录里；不提交等于没交付 |
| 只有 dev/qa/ops 模板带 `workdir_edit` | product/architect/ux/ui 无法直接写项目目录 |
| 产出物 manifest 有 `submitter`（署名） | 但**文件级**没有归属记录：谁写的、谁能改都无从判定 |
| 设计文档写过"跨 Agent 文件锁（M5）" | **未实现**（`code-edit-store` 只有 diff 轨迹）→ 任何角色都能覆盖任何人的产出 |

## 2. 目标模型

```
项目工作目录（workdir）＝ 唯一产出地
  ├─ 每个文件登记 owner（实例 id + 显示名 + 首次/最近修改时间 + 最近任务）
  ├─ 写入前校验：无主 → 可写（写完即认领）；owner=自己 → 可写；owner=他人 → **拒绝**
  └─ 非 owner 只能读；需要新版本请**另建新文件**（如 x.v2.md），不得改他人文件

系统提示注入：[我的产出物（可改）] / [他人产出物（只读）] → 角色知道"自己在哪改自己的东西"
```

## 3. 改动范围

### A. 取消私有工作区

- `src/infra/tools/executor.ts`：**删除 `ws_write` / `ws_read` 工具**（私有区不再有写入口）。
- 8 个角色模板：移除 `ws_read/ws_write`；**productive 角色**（product/architect/ux/ui）补 `workdir_edit`
  （dev/qa/ops 已有）。**pm 仍不给 `workdir_edit`**（项目经理只协调、不产出——用户早前要求）。
- `artifact_submit` 语义改为「**为项目目录里已写好的文件登记产出物**（版本快照 + manifest + 署名）」：
  源 = 工作目录内相对路径（不再从 ws 拷贝）；保留 `fromWsRel` 兼容字段供历史/服务层单测。
- 系统提示：删除"ws:// 是草稿区、必须 artifact_submit 才算交付"的说法，改为
  "**所有产出直接写进项目工作目录**（workdir_edit / workdir:// 路径），项目目录是唯一交付地"。
- `wsRoot` 解析与 `workspaces/<iid>/` 目录保留（旧记录/兼容），但没有工具能写它。

### B. 署名与归属（新 `FileOwnerStore`）

- 新增 `src/application/artifact/file-owner-store.ts`：`file-owners.jsonl`，一行一条
  `{ relPath, owner, ownerName, firstAt, lastAt, edits, lastTaskId, via: 'workdir_edit'|'artifact_submit' }`。
  - `assertWritable(pid, relPath, actor)`：owner 存在且 ≠ actor → 抛 `ERR_FORBIDDEN`（消息点名 owner，
    并提示"可另建新文件"）；无主 → 放行。
  - `claim(pid, {relPath, owner, ownerName, taskId, via})`：首次登记 / 更新 `lastAt`+`edits`。
  - `mine(pid, owner)` / `others(pid, owner)` / `list(pid)`。
- 新增 `src/infra/util/keyed-lock.ts`（`KeyedLock`）：`TaskService` 的单项目锁抽出来复用，归属表写入也用同一把锁
  （避免并发写丢记录）。

### C. 权限校验点

- `workdir_edit`：写前 `assertWritable` → 写后 `claim`（署名 + 任务归属）；回执写明「署名 <显示名>」。
- `artifact_submit`：登记前对每个 `relPath` 做 `assertWritable`，登记后 `claim(via:'artifact_submit')`。
- 越权错误回执包含：`该文件属 <owner 显示名>（<owner>）所有，你只能改自己名下的文件；如需新版本请另建新文件`。

### D. 提示注入（"自己在哪改自己的产出物"）

- `loop-runner` 新增 `toolRuntime.fileOwnership(ctx)` 钩子 →
  `[我的产出物（可改）]`（列出 path / 更新时间 / 最近任务）与
  `[他人产出物（只读，不可改；需要新版本请另建文件）]`（最多各 8 条）。
- `composition` 用 `FileOwnerStore` + `teamService` 拼装（显示名 = 团队成员 displayName）。

### E. 接口与测试

- `GET /api/projects/:pid/file-owners` → 归属列表（供前端/审计查看署名）。
- 新增 `tests/file-ownership-m8o.test.ts`：首次写认领署名、同角色可续写、**他人写入被拒且文件未变**、
  无主既有文件可写、另建新文件可行、artifact_submit 越权被拒、越权登记不落 manifest、提示块内容、
  `ws_write/ws_read` 已下线（注册表里不存在）。
- 更新：`tests/tools-m3.test.ts`（删 ws 用例、会议内改测 workdir_edit 不可用）、
  `tests/artifact-submit-m8j.test.ts`（ws_write → workdir_edit + 就地登记）。

## 4. 验证

- `npx tsc -p tsconfig.json` / `npx eslint .` / `npx vitest run --pool=threads` 全绿。
- 真实网络冒烟：起 `dist` 服务，dev 写文件 → 返回含署名；qa 改同一文件 → 被拒且内容未变；
  qa 另建新文件 → 成功且各自署名；`GET /file-owners` 列出两条。

## 5. 边界（本轮不做）

- **不做转交/接管**（用户选 B）：跨角色只能另建新文件；如需改他人文件由用户自己改（用户永远可写）。
- `cmd_run` 执行命令**不按 owner 限制**（无法静态判定命令会写哪些文件）——已在文档标注为已知边界。
- 回退（rollback）接口保留但不做 owner 校验（当前无 UI 入口）。
- 不做前端"文件署名"面板（本轮以写入回执 + `GET /file-owners` + 提示注入体现署名）。
