import { registerTool } from '../../../infra/tools/executor.js'
import type { ServiceToolDeps } from './context.js'
import { AppError, ErrorCodes } from '../../../shared/errors.js'

/** `artifact_submit`：把项目目录里的文件登记为一条产出物（版本快照 + 署名）。 */
export function registerArtifactSubmitTool(deps: ServiceToolDeps): void {
  const { artifacts, fileOwners, listTeam, stripWs } = deps
  if (artifacts && fileOwners && listTeam) {
      registerTool(
        {
          name: 'artifact_submit',
          description:
            '把你的产出**登记为产出物**：为工作目录里已写好的文件建一条产出物记录 + 版本快照 + 署名' +
            '（不移动文件；产出物本来就在项目目录里）。只能登记自己名下的文件',
          scope: 'platform',
          availableIn: ['user'],
          idempotent: false,
          paramsSchema: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '产出物标题（如「登录模块 PRD」）' },
              type: {
                type: 'string',
                enum: ['doc', 'code', 'config', 'test', 'deploy'],
                description: '产出物类型，缺省 doc',
              },
              summary: { type: 'string', description: '一句话说明（可选）' },
              files: {
                type: 'array',
                description: '要登记的产出物文件：relPath = 项目工作目录内的相对路径',
                items: {
                  type: 'object',
                  properties: {
                    relPath: { type: 'string', description: '如 docs/prd.md' },
                    fromWsRel: {
                      type: 'string',
                      description: '（已废弃）旧私有区路径；私有区已取消，请用 relPath',
                    },
                  },
                  required: ['relPath'],
                },
              },
              path: {
                type: 'string',
                description: '单文件简写：工作目录相对路径（等价 files=[{relPath:path}]）',
              },
              relPath: { type: 'string', description: '单文件简写：工作目录相对路径' },
            },
            required: ['title'],
          },
        },
        async (args, env) => {
          const title = String(args.title ?? '').trim()
          if (!title) return { ok: false, code: 'ERR_VALIDATION', reason: 'title 必填' }
          const type = String(args.type ?? 'doc').trim()
          if (!['doc', 'code', 'config', 'test', 'deploy'].includes(type)) {
            return { ok: false, code: 'ERR_VALIDATION', reason: `不支持的产出物类型: ${type}` }
          }
          const rawFiles = Array.isArray(args.files) ? args.files : []
          const list: Array<{ fromWsRel: string; relPath: string }> = []
          for (const f of rawFiles) {
            if (typeof f !== 'object' || f === null) continue
            const row = f as Record<string, unknown>
            const relRaw = String(row.relPath ?? '').trim()
            const legacy = String(row.fromWsRel ?? '').trim()
            // 私有区已取消：新调用只认 relPath；历史 fromWsRel 仅作兼容
            const relPath = relRaw || stripWs(legacy)
            if (!relPath) continue
            list.push({ fromWsRel: legacy || `workdir://${relPath}`, relPath })
          }
          if (!list.length && (args.path || args.relPath)) {
            const relPath =
              String(args.relPath ?? '').trim() || stripWs(String(args.path ?? '').trim())
            if (relPath) list.push({ fromWsRel: `workdir://${relPath}`, relPath })
          }
          if (!list.length) {
            return {
              ok: false,
              code: 'ERR_VALIDATION',
              reason: 'files 不能为空（或提供 path/relPath 单文件简写）',
            }
          }
          // 署名与归属：不能把他人产出物登记/覆盖成自己的
          if (fileOwners) {
            for (const f of list) {
              try {
                await fileOwners.assertWritable(env.projectId, f.relPath, env.instanceId)
              } catch (e) {
                return {
                  ok: false,
                  code: e instanceof AppError ? e.code : ErrorCodes.FORBIDDEN,
                  reason: e instanceof Error ? e.message : String(e),
                }
              }
            }
          }
          // 产出物提交**不走审批门**（用户要求，2026-09-09）
          const needsApproval = false
          try {
            const { record } = await artifacts.submit({
              projectId: env.projectId,
              actor: env.instanceId,
              sessionId: env.sessionId,
              taskId: env.taskId ?? null,
              type: type as never,
              title,
              summary: args.summary === undefined ? '' : String(args.summary),
              files: list,
              needsApproval,
            })
            let ownerName = env.instanceId
            if (fileOwners) {
              const team = listTeam ? await listTeam(env.projectId).catch(() => []) : []
              ownerName =
                team.find((m) => m.instanceId === env.instanceId)?.displayName ?? env.instanceId
              for (const f of list) {
                await fileOwners
                  .claim(env.projectId, {
                    relPath: f.relPath,
                    owner: env.instanceId,
                    ownerName,
                    taskId: env.taskId ?? null,
                    via: 'artifact_submit',
                  })
                  .catch(() => undefined)
              }
            }
            const where = list.map((f) => f.relPath).join('、')
            return {
              ok: true,
              summary:
                `已登记产出物 ${record.id}「${title}」v${record.version} → ${where}` +
                `｜署名 ${ownerName}（${env.instanceId}）｜版本快照已存`,
            }
          } catch (e) {
            return {
              ok: false,
              code:
                e instanceof Error && 'code' in e
                  ? String((e as { code: string }).code)
                  : 'ERR_TOOL_REJECTED',
              reason: e instanceof Error ? e.message : String(e),
            }
          }
        },
      )
  }
}
