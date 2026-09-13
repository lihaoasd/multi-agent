import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { registerTool } from '../../../infra/tools/executor.js'
import { ensureInside } from '../../../domain/rules/path-boundary.js'
import { resolveVirtual } from '../../../domain/rules/path-resolver.js'
import { AppError, ErrorCodes } from '../../../shared/errors.js'
import type { ServiceToolDeps } from './context.js'

/** `workdir_edit`：**项目工作目录唯一写通道**（2026-09-12 取消私有区）。改动按 taskId 聚合成 code-edits 轨迹，并按 file-owners 校验归属（他人产出物不可改）。 */
export function registerWorkdirEditTool(deps: ServiceToolDeps): void {
  const { codeEdits, fileOwners, listTeam } = deps
    // 项目工作目录受控编辑（**唯一写通道**，2026-09-12 取消私有区）
    registerTool(
      {
        name: 'workdir_edit',
        description:
          '写项目工作目录（唯一产出地；单文件、声明式替换/写入，留 diff 轨迹并署名）。' +
          '只能改自己名下的文件（见系统提示 [我的产出物]）；写他人文件会被拒，请另建新文件',
        scope: 'workdir',
        availableIn: ['user'],
        idempotent: false,
        paramsSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '工作目录内虚拟路径，如 workdir://src/a.ts' },
            edits: {
              type: 'array',
              description: '按顺序应用的编辑；write 覆盖全文，replace 做精确替换',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['write', 'replace'] },
                  text: { type: 'string', description: 'type=write 时的全文' },
                  oldText: { type: 'string', description: 'type=replace 时的被替换文本' },
                  newText: { type: 'string', description: 'type=replace 时的替换文本' },
                },
                required: ['type'],
              },
            },
          },
          required: ['path', 'edits'],
        },
      },
      async (args, env) => {
        const path = String(args.path ?? '')
        const edits = Array.isArray(args.edits) ? (args.edits as Array<Record<string, unknown>>) : []
        if (!path || edits.length === 0) {
          return { ok: false, code: 'ERR_VALIDATION', reason: 'path 与 edits 必填' }
        }
        const r = resolveVirtual(path, env.roots)
        if (r.scheme !== 'workdir') {
          return {
            ok: false,
            code: 'FS_BOUNDARY',
            reason: 'workdir_edit 仅限 workdir:// 内文件（私有区已取消，所有产出直接写项目目录）',
          }
        }
        const abs = ensureInside(env.roots.workdirRoot, r.absolute, 'relPath')
        // 归属锚点：dispatcher 注入的当前任务优先（D15）；模型自报仅作兜底
        const taskId =
          env.taskId ?? (args.taskId ? String(args.taskId) : `untracked_${env.instanceId}`)

        // 署名与归属：他人名下文件不可改（2026-09-12，用户要求"其他人不能动"）
        if (fileOwners) {
          try {
            await fileOwners.assertWritable(env.projectId, r.rel, env.instanceId)
          } catch (e) {
            return {
              ok: false,
              code: e instanceof AppError ? e.code : ErrorCodes.FORBIDDEN,
              reason: e instanceof Error ? e.message : String(e),
            }
          }
        }

        // 逐条应用编辑（整体事务：任一步失败不改文件）
        let current = await readFile(abs, 'utf8').catch(() => '')
        const originalLength = current.length
        for (const raw of edits) {
          const e = raw as Record<string, unknown>
          // 类型推断（2026-09-12 数据安全修复）：模型常漏 type。
          // 旧实现把缺省 type 当 write、text 缺失即写空串 → **会把整文件清空**（已发生：PRD 被写成 0 字节）。
          const declared = e.type === undefined ? '' : String(e.type).trim()
          const hasText = Object.prototype.hasOwnProperty.call(e, 'text')
          const hasReplacePair =
            Object.prototype.hasOwnProperty.call(e, 'oldText') ||
            Object.prototype.hasOwnProperty.call(e, 'newText')
          const type = declared || (hasReplacePair ? 'replace' : hasText ? 'write' : '')
          if (type === 'write') {
            if (!hasText) {
              return {
                ok: false,
                code: 'ERR_VALIDATION',
                reason:
                  'write 必须显式提供 text 字段：为避免误清空文件，缺少 text 的 write 一律拒绝' +
                  '（想做替换请用 {type:"replace", oldText, newText}）',
              }
            }
            const text = String(e.text ?? '')
            if (text === '') {
              return {
                ok: false,
                code: 'ERR_VALIDATION',
                reason:
                  '拒绝对工作目录文件写入空内容（write 的 text 不能为空）。' +
                  '如确需清空，请先用 replace 删掉正文或改派任务说明意图',
              }
            }
            current = text
          } else if (type === 'replace') {
            const oldText = String(e.oldText ?? '')
            const newText = String(e.newText ?? '')
            if (oldText === '')
              return { ok: false, code: 'ERR_VALIDATION', reason: 'replace 需 oldText' }
            if (!current.includes(oldText)) {
              return {
                ok: false,
                code: 'ERR_CONFLICT',
                reason: `替换目标不存在（文件已被外部修改?）：${JSON.stringify(oldText.slice(0, 60))}`,
              }
            }
            current = current.split(oldText).join(newText)
          } else {
            return {
              ok: false,
              code: 'ERR_VALIDATION',
              reason:
                '每次编辑需要 type（write 全文 / replace 精确替换），或提供 text / oldText+newText 让平台推断',
            }
          }
        }
        // 回执里的"+N 字符"按真实净变化算（旧实现按写入长度累加，写空文件时会误报"无净变化"）
        const netChange = current.length - originalLength
        const changed = netChange !== 0
        await mkdir(dirname(abs), { recursive: true })
        await writeFile(abs, current, 'utf8')
        if (changed) {
          await codeEdits.append(env.projectId, taskId, {
            relPath: r.rel,
            editType:
              edits.length === 1 && String(edits[0]!.type ?? '') === 'write' ? 'write' : 'replace',
            changedChars: Math.abs(netChange),
          })
        }
        // 认领/续写归属（署名）
        let ownerName = env.instanceId
        if (fileOwners) {
          const team = listTeam ? await listTeam(env.projectId).catch(() => []) : []
          ownerName = team.find((m) => m.instanceId === env.instanceId)?.displayName ?? env.instanceId
          await fileOwners
            .claim(env.projectId, {
              relPath: r.rel,
              owner: env.instanceId,
              ownerName,
              taskId: env.taskId ?? null,
              via: 'workdir_edit',
            })
            .catch(() => undefined)
        }
        return {
          ok: true,
          summary:
            `已编辑 ${r.rel}（${netChange >= 0 ? '+' : ''}${netChange} 字符` +
            `｜署名 ${ownerName}（${env.instanceId}）｜归属 ${taskId}`,
        }
      },
    )
}
