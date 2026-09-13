# 修改记录 · 重构 P1c：`artifact-service` 迁移 + 合法例外裁定 + 分层规则收紧

> 日期：2026-09-14 · 阶段：P1c（`docs/plan/2026-09-14-refactor-architecture.md` 的 P1 收尾）
> 类型：纯重构（**无业务行为改动**、无 REST/WS 契约变化、无数据格式变化）

## 需求/问题

P1a/P1b 把 13 个持久化 store 迁到了存储抽象。P1c 收尾三件事：

1. `artifact-service`（剩余最大，18 处 IO）—— 但它不是键值存储，不能硬塞进门面；
2. 给"哪些 IO 是合法例外"一个**书面裁定**，避免后续被反复误判；
3. 收紧分层规则，让剩余违规变成**可信的待办清单**。

## 改动范围

| 文件 | 改动 |
| --- | --- |
| `src/ports/file-ops.ts` | 新增：`FileOps` 端口（真实文件内容搬运：工作目录交付物、版本快照） |
| `src/infra/store/local-file-ops.ts` | 新增：`FileOps` 默认实现（唯一允许用 `node:fs` 做内容搬运处） |
| `src/application/artifact/artifact-service.ts` | 迁移：manifest 走门面；拷贝/快照/指纹走 `FileOps` |
| `src/shared/util/id.ts` | `git mv` 自 `src/infra/util/id.ts`（纯工具，无 IO、无依赖） |
| 15 个 application 文件 | `id` 导入路径改为 `shared/util` |
| `eslint.config.js` | 分层规则加 `allowTypeImports`（只禁运行期依赖） |
| `tests/artifact-m4.test.ts` | 装配 1 处（新增 `FileOps` 注入） |

## 关键实现

### 1. 为什么 `artifact-service` 需要**另一个端口**

`storage.ts` 管的是**项目运行时记录**（JSONL/JSON：会话日志、任务、审批），寻址 = 项目相对路径。
而 `artifact-service` 真正在做的是：

- 把交付物**拷进用户工作目录**（`workdir` 在项目之外，不受项目相对路径约束）
- 把内容**快照到 `artifact-versions/<id>/v<version>/`**
- 对内容做 **sha256 指纹 + 字节数**

这三件事不是"记录存储"，塞进 `ProjectStore` 会扭曲它的语义。因此单列薄的 `FileOps` 端口。
迁移后 `ArtifactService` 的 IO 全部经由端口，`node:fs`/`node:crypto` 从该文件消失
（`createHash` 下沉到 `FileOps.fingerprint`）。

### 2. 4 处"合法例外"（书面裁定，不是遗留）

P1 的目标是**项目运行时持久化 IO 归零**，而不是"application 层一个 `node:fs` 都不许有"。
以下 4 处访问的对象本就不是项目运行时存储，强行抽象才是设计错误：

| 文件 | 访问对象 | 为何不抽象 |
| --- | --- | --- |
| `application/fs-browse/fs-browse-service.ts` | **用户任意目录**（目录选择器） | 功能本身就是"浏览任意目录" |
| `application/export/export-service.ts` | 项目运行时目录整棵打包成 zip | 导出功能本身；递归遍历无法用键值端口表达 |
| `application/project/project-service.ts` 的 `detectWorkdirKind` | **用户工作目录** | 判断"空目录 / 既有仓库"必须扫工作目录 |
| `application/tools/service-tools.ts` 的 `workdir_edit` | **项目工作目录的交付物** | 这是产品交付路径，不是运行时存储 |
| `application/roles/role-service.ts` | `<dataDir>/roles/*.yaml` **角色库** | 非项目作用域、非运行时记录（YAML 模板库）；需要独立的全局作用域端口，不属于 `ProjectStore` |

> 前 4 处按现状保留；`role-service` 记为**待办**（需要一个全局作用域的小端口），
> 它不在"项目运行时存储"这个抽象的目标范围内，但方向问题真实存在。

### 3. 分层规则收紧：`allowTypeImports`

剩余 50 条 warning 里有 **20 条是误报**：`import type { ProjectStore } from '../infra/store/…'`
只用于类型标注，编译后不产生任何 `require`/`import`，方向问题只存在于类型层。

因此给规则的 **每个 pattern 项**加 `allowTypeImports: true`
（注意：ESLint 10 里它是 pattern 项属性，**不是规则顶层属性**——放顶层会直接配置报错）。

效果：**50 → 30 条 warning**，剩下的 30 条全部是**运行期真实依赖**。

### 4. `util/id` 上移到 `shared/util`

`id.ts` 是纯工具（无 IO、无依赖），application 依赖它却违反"不得依赖 infra"——这是**伪违规**。
用 `git mv` 迁到 `src/shared/util/id.ts`（保留 CRLF 与 UTF-8 内容），15 个导入路径同步调整。

> 过程约束：该文件含中文注释，整文件批量替换**有破坏编码的前车之鉴**（P1a/P1b 各踩一次），
> 因此本次只替换 **import 路径所在行**（纯 ASCII），并在改后验证中文完好、CRLF 未变。

效果：lint warning **30 → 15**。

## 验证结果

| 项 | 结果 |
| --- | --- |
| `npx tsc -p tsconfig.json` | ✅ 无输出 |
| `npm run test`（全量） | ✅ **49 文件 / 315 用例**通过，23.7s（负载已恢复） |
| `npx eslint .` | ✅ 0 error / **15 warning**（P1 起点为 50） |

累计收敛：**50 → 30（allowTypeImports）→ 15（util/id 上移）**。

## 剩余 15 条待办（下轮 P1d）

| 来源 | 条数 | 需要的抽象 |
| --- | --- | --- |
| `../../infra/file-store/fs-utils.js` | 4 | 路径边界校验（`ensureInside`/`isPathInside`）移入 `ports` 或 `shared`；`dirExists` 已由门面覆盖 |
| `../../infra/tools/executor.js` | 3 | 工具契约端口（注册表接口 + 工具定义类型） |
| `../../infra/model/gateway.js` | 1 | 模型网关端口（运行时值导入） |
| `domain/rules/path-resolver.ts`（`node:path` + `fs-utils`） | 2 | P2 处理：domain 不得依赖 Node 内置模块与 infra |
| `server/app.ts` 深入 application 内部模块 | 6 | P4 处理：路由拆分后只依赖 `Services` 门面 |

> 说明：这 15 条里 6 条属 P4、2 条属 P2 的既定范围，其余 7 条需要一个 P1d 的"端口补齐"小阶段。
> 棘轮机制保证**新增代码不会再产生**这类违规（新文件立即 error）。
