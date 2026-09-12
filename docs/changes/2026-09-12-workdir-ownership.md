# 2026-09-12 取消私有工作区：产出落项目目录 + 署名 + 归属锁

## 需求/问题

用户："修改工作空间，所有角色的产出都放到项目目录里，需要标记自己的姓名，自己在哪修改自己的产出物，
其他人不能动"

改造前：

1. 角色先在 `ws://` 私有区写，再 `artifact_submit` 拷贝进项目目录——**产出默认不在项目目录里**；
2. 只有 dev/qa/ops 模板有 `workdir_edit`，product/architect/ux/ui 无法直接写项目目录；
3. 产出物 manifest 有 `submitter`，但**文件级**没有归属记录；
4. 设计文档里写的"跨 Agent 文件锁（M5）"**未实现**——任何角色都能覆盖任何人的产出。

用户确认：**A. 取消私有区（所有角色直接在项目目录产出）**；**B. 他人文件只读 + 新建文件（不做转交）**。

## 改动范围

### 一、取消私有工作区

- `src/infra/tools/executor.ts`：**删除 `ws_write` / `ws_read` 工具注册**（私有区不再有写入口）。
- 8 个角色模板：移除 `ws_read/ws_write`；**product/architect/ux/ui 补 `workdir_edit`**（dev/qa/ops 已有）；
  pm 仍无写权限（只协调不产出，产物交给其他角色）；角色 `systemPrompt` 同步改为"产出直接写项目工作目录"。
- `artifact_submit` 语义改为「**为项目目录里已写好的文件登记产出物**」：源 = `relPath`（兼容旧 `fromWsRel`，
  且允许 `workdir://` 前缀），不移动文件；`ArtifactService.execute()` 在 `src === dest` 时只做快照不拷贝。
- 系统提示：删除"ws:// 是草稿区、必须 artifact_submit 才算交付"，改为
  "所有产出直接写进项目工作目录；你只能改自己名下的文件".

### 二、署名与归属（新）

- 新增 `src/application/artifact/file-owner-store.ts`（`file-owners.jsonl`）：
  `{ relPath, owner, ownerName, firstAt, lastAt, edits, lastTaskId, via }`；
  `assertWritable()`（他人 → `ERR_FORBIDDEN`，消息点名 owner 并提示另建新文件）、`claim()`、`mine/others/list`。
- 新增 `src/infra/util/keyed-lock.ts`（`KeyedLock`）：`TaskService` 的单项目锁抽出来复用，归属表写入同锁，
  避免并发写丢记录（`TaskService` 改为持有 `KeyedLock` 实例）。
- 新增错误码 `ERR_FORBIDDEN`（HTTP 403）。
- `GET /api/projects/:pid/file-owners[?owner=]`：列出署名与归属（ownerName 兜底从团队配置解析）。

### 三、写入点校验 + 署名回执

- `workdir_edit`：写前 `assertWritable`（`ERR_FORBIDDEN` 直接回注模型）；写后 `claim`；
  回执示例：`已编辑 src/snake.js（+12 字符）｜署名 高级开发（dev_1）｜归属 t_…`。
- `artifact_submit`：登记前逐个 `assertWritable`（越权不落 manifest）；登记后 `claim(via:'artifact_submit')`；
  回执含 `｜署名 X（id）｜版本快照已存`。
- 提示注入：`toolRuntime.fileOwnership(ctx)` → `[我的产出物（可改）]` 与
  `[他人产出物（只读，不可改；需要新版本请另建文件）]`（各最多 8 条）。

### 四、测试 / 文档

- 新增 `tests/workdir-ownership-m8o.test.ts`（9 例）：首写认领署名、同角色续写、**他人写入被拒且文件未变**、
  replace 同样被拦、另建新文件可行、无主既有文件可写、artifact_submit 越权被拒（不落 manifest）、
  `GET /file-owners` 列表与过滤、提示块注入、私有区工具已下线。
- 更新：`tests/tools-m3.test.ts`（ws 用例改为"工具已下线" + 会议内 `workdir_edit` 不可用）、
  `tests/artifact-submit-m8j.test.ts`（改为 workdir_edit 产出 + 就地登记 + 署名断言）。
- 文档：`docs/plan/2026-09-12-workdir-ownership.md`、本记录、`README.md`、
  `docs/design/workspaces-artifacts.md`（§1/§2 重写、§4 状态机、§5 归属锁、§6）、
  `docs/design/tools.md`（工具表与矩阵、三条通道）、`docs/design/data-storage.md`（目录树 + §6.1）、
  `docs/api/contract.md`（路由 + `ERR_FORBIDDEN`）。

## 验证结果

- `npx tsc -p tsconfig.json` → 0；`npx eslint .` → 0
- `npx vitest run --pool=threads` → **29 文件 / 179 用例全绿**
- 真实网络冒烟（`node dist` + 真实服务与工具调用）：
  ```
  ① 私有区工具  → 已下线（ERR_TOOL_REJECTED）
  ② dev 写产出  → 已编辑 src/snake.js（+12 字符）｜署名 高级开发（dev_1）｜归属 untracked_dev_1
  ③ qa 改 dev 的文件 → ERR_FORBIDDEN: src/snake.js 属 高级开发（dev_1）所有，你（qa_1）不能修改他人产出物；
                       如需新版本，请另建新文件（例如加版本后缀），或让用户协调
     磁盘内容仍为 → "// snake v1\n"
  ④ qa 另建新文件 → 已编辑 tests/snake.test.md（+7 字符）｜署名 测试工程师（qa_1）
  ⑤ 署名与归属 → tests/snake.test.md [测试工程师 / qa_1] | src/snake.js [高级开发 / dev_1]
  ```

## 语义变更（需知悉）

| 项 | 旧 | 新 |
| --- | --- | --- |
| 产出位置 | 先写 ws:// 私有区，提交才进项目目录 | **直接写项目目录**（唯一产出口） |
| 谁能写项目目录 | 仅 dev/qa/ops | productive 角色全员（pm 除外，只协调） |
| 产出署名 | 仅 artifact manifest 的 submitter | 每个文件 `file-owners.jsonl`（owner + 显示名 + 时间 + 次数） |
| 改他人文件 | 允许（无校验） | **拒绝** `ERR_FORBIDDEN`（只读 + 另建新文件） |
| 无主文件 | — | 可写，首写认领（用户既有仓库文件可被角色接手） |
| `artifact_submit` | 从私有区拷贝落地 | 为项目目录文件登记版本快照 + 署名 |

## 边界（本轮不做）

- 不做转交/接管（用户选 B）；跨角色只能另建新文件；**用户本人始终可改**（不经归属校验）。
- `cmd_run` 命令副作用不受归属锁约束；回退接口不做 owner 校验（当前无 UI 入口）。
- 未做前端"文件署名"面板（署名通过写入回执、`GET /file-owners`、系统提示注入体现）。
- 未做浏览器人工目视验收。
