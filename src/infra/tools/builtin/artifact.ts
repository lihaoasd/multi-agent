import type { ArtifactService } from '../../../ports/artifact'
import type { ArtifactType } from '../../../shared/artifacts'
import { ARTIFACT_TYPES } from '../../../shared/artifacts'
import type { PathResolver } from '../../../ports/path-resolver'
import type { ToolDefinition, ToolHandler, ToolOutcome } from '../../../ports/tools'
import { relativizeInside } from '../../fs/workdir-fs'

/**
 * 产出物工具（workspaces-artifacts §2、tools.md §6）：
 * - `workdir_edit`：**唯一写通道**（单文件、归属校验 + 署名 + diff 审计）；
 * - `artifact_submit`：登记已写好的文件（版本快照/补丁 + manifest + 署名），不移动文件；
 * - `artifact_rollback`：按版本内容依据回退（高风险 → 走审批）。
 */

const SESSION_USER_ONLY = ['user'] as const

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}

function readStringArray(record: Record<string, unknown> | undefined, key: string): readonly string[] {
  const value = record?.[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readBoolean(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = record?.[key]
  return typeof value === 'boolean' ? value : undefined
}

export interface ArtifactToolDeps {
  readonly artifacts: ArtifactService
  readonly paths: PathResolver
  /** 当前激活任务（dispatcher 注入的上下文）；缺省 null = 按回合兜底 */
  readonly activeTaskId: (context: { readonly projectId: string; readonly instanceId: string }) => Promise<string | null>
}

/** 工具参数里的虚拟路径 → 工作目录内 relPath（越界/非 workdir 返回错误） */
async function resolveWorkdirRelPath(
  deps: ArtifactToolDeps,
  path: string,
  roots: import('../../../ports/path-resolver').PathRoots,
): Promise<{ readonly ok: true; readonly relPath: string } | { readonly ok: false; readonly message: string; readonly code: string }> {
  const resolved = deps.paths.resolve(path, roots)
  if (!resolved.ok) return { ok: false, message: resolved.error.message, code: resolved.error.code }
  const relPath = relativizeInside(roots.workdir, resolved.value.absolute)
  if (relPath === null) {
    return { ok: false, message: `只能写项目工作目录内的文件：${path}`, code: 'ERR_FORBIDDEN_PATH' }
  }
  return { ok: true, relPath }
}

export function workdirEditTool(deps: ArtifactToolDeps): { definition: ToolDefinition; handler: ToolHandler } {
  return {
    definition: {
      name: 'workdir_edit',
      package: 'artifact',
      description:
        '在项目工作目录内写入/覆盖一个文本文件（唯一写通道）。只能修改归属自己的文件（他人产出物只读，请另建新文件）；写入即署名并留 diff 审计。',
      paramsSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '虚拟路径，如 workdir://src/login.ts' },
          content: { type: 'string', description: '完整文件内容（覆盖写）' },
        },
        required: ['path', 'content'],
      },
      scope: 'workdir',
      risk: 'low',
      network: 'none',
      idempotent: false,
      availableIn: [...SESSION_USER_ONLY],
      allowedRoots: ['workdir'],
      output: { maxChars: 2_000, strategy: 'truncate-tail' },
    },
    async handler(input, context): Promise<ToolOutcome> {
      const record = asRecord(input)
      const path = readString(record, 'path')
      const content = readString(record, 'content')
      if (path === undefined || path.trim().length === 0) return { ok: false, text: '缺少 path', errorCode: 'ERR_VALIDATION' }
      if (content === undefined) return { ok: false, text: '缺少 content', errorCode: 'ERR_VALIDATION' }

      const target = await resolveWorkdirRelPath(deps, path, context.roots)
      if (!target.ok) return { ok: false, text: target.message, errorCode: target.code }

      const taskId = await deps.activeTaskId({ projectId: context.projectId, instanceId: context.instanceId })
      const written = await deps.artifacts.editFile({
        projectId: context.projectId,
        instanceId: context.instanceId,
        relPath: target.relPath,
        content,
        taskId,
        sessionId: context.sessionId,
        turn: context.turn,
      })
      if (!written.ok) return { ok: false, text: written.error.message, errorCode: written.error.code }
      return {
        ok: true,
        text: `已${written.value.action === 'add' ? '新建' : '修改'} ${target.relPath}（署名：你｜+${written.value.diff.add}/-${written.value.diff.del}，sha256=${written.value.hash.slice(0, 12)}）`,
        data: { relPath: target.relPath, action: written.value.action, diff: written.value.diff },
      }
    },
  }
}

export function artifactSubmitTool(deps: ArtifactToolDeps): { definition: ToolDefinition; handler: ToolHandler } {
  return {
    definition: {
      name: 'artifact_submit',
      package: 'artifact',
      description:
        '把工作目录里已经写好的文件登记为产出物（版本快照 + manifest + 署名，不移动文件）。省略 files 时登记本任务/本回合的全部改动；code 类提交会按任务聚合。',
      paramsSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '产出物标题（如「登录模块实现」）' },
          summary: { type: 'string', description: '一句话摘要（写进 manifest，供审计与索引）' },
          type: {
            type: 'string',
            enum: [...ARTIFACT_TYPES],
            description: '产出物类型，默认 doc',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: '要登记的文件（workdir:// 虚拟路径）；省略则登记本任务/本回合的全部改动',
          },
        },
        required: ['title'],
      },
      scope: 'workdir',
      risk: 'low',
      network: 'none',
      // 是否需审批由 PolicyEngine 按项目 artifactPolicy（docSubmitApproval/codeSubmitApproval）判定
      needsApproval: false,
      idempotent: false,
      availableIn: [...SESSION_USER_ONLY],
      allowedRoots: ['workdir'],
      output: { maxChars: 2_000, strategy: 'truncate-tail' },
      policyAction: (call) => {
        const record = asRecord(call)
        if (record === undefined) return null
        const rawType = readString(record, 'type') ?? 'doc'
        if (!(ARTIFACT_TYPES as readonly string[]).includes(rawType)) return null
        return {
          kind: 'submit',
          tool: 'artifact_submit',
          artifactType: rawType as ArtifactType,
          risk: 'low',
          network: 'none',
          needsApproval: false,
        }
      },
    },
    async handler(input, context): Promise<ToolOutcome> {
      const record = asRecord(input)
      const title = readString(record, 'title')
      if (title === undefined || title.trim().length === 0) {
        return { ok: false, text: '缺少 title', errorCode: 'ERR_VALIDATION' }
      }
      const rawType = readString(record, 'type') ?? 'doc'
      if (!(ARTIFACT_TYPES as readonly string[]).includes(rawType)) {
        return { ok: false, text: `未知产出物类型：${rawType}`, errorCode: 'ERR_VALIDATION' }
      }

      const relPaths: string[] = []
      for (const file of readStringArray(record, 'files')) {
        const target = await resolveWorkdirRelPath(deps, file, context.roots)
        if (!target.ok) return { ok: false, text: target.message, errorCode: target.code }
        relPaths.push(target.relPath)
      }

      const taskId = await deps.activeTaskId({ projectId: context.projectId, instanceId: context.instanceId })
      const submitted = await deps.artifacts.submit({
        projectId: context.projectId,
        instanceId: context.instanceId,
        title,
        summary: readString(record, 'summary') ?? '',
        type: rawType as ArtifactType,
        ...(relPaths.length === 0 ? {} : { relPaths }),
        taskId,
        sessionId: context.sessionId,
        turn: context.turn,
      })
      if (!submitted.ok) return { ok: false, text: submitted.error.message, errorCode: submitted.error.code }
      const value = submitted.value
      return {
        ok: true,
        text: `已登记产出物 ${value.id}（${value.type}「${value.title}」v${value.version}，${value.files.length} 个文件，+${value.diffSummary.add}/-${value.diffSummary.del}，state=${value.state}）`,
        data: {
          artifactId: value.id,
          type: value.type,
          version: value.version,
          state: value.state,
          files: value.files.length,
          diffSummary: value.diffSummary,
          versionDir: value.versionDir,
        },
      }
    },
  }
}

export function artifactRollbackTool(deps: ArtifactToolDeps): { definition: ToolDefinition; handler: ToolHandler } {
  return {
    definition: {
      name: 'artifact_rollback',
      package: 'artifact',
      description:
        '回退自己提交过的产出物版本（把该版本涉及的文件恢复为其提交前内容，产生一条 state=reverted 的新版本）。文件在目标版本后被改动过会被拒绝，需用户确认后传 force=true。',
      paramsSchema: {
        type: 'object',
        properties: {
          artifactId: { type: 'string', description: '产出物 id，如 a_xxx' },
          version: { type: 'number', description: '要回退到的版本号' },
          force: { type: 'boolean', description: '文件已被后续修改时是否强制覆盖（默认 false）' },
        },
        required: ['artifactId', 'version'],
      },
      scope: 'workdir',
      risk: 'high',
      network: 'none',
      idempotent: false,
      availableIn: [...SESSION_USER_ONLY],
      allowedRoots: ['workdir'],
      output: { maxChars: 2_000, strategy: 'truncate-tail' },
    },
    async handler(input, context): Promise<ToolOutcome> {
      const record = asRecord(input)
      const artifactId = readString(record, 'artifactId')
      const version = readNumber(record, 'version')
      if (artifactId === undefined || version === undefined) {
        return { ok: false, text: '缺少 artifactId 或 version', errorCode: 'ERR_VALIDATION' }
      }
      const rolled = await deps.artifacts.rollback({
        projectId: context.projectId,
        instanceId: context.instanceId,
        artifactId,
        version: Math.floor(version),
        ...(readBoolean(record, 'force') === true ? { force: true } : {}),
        sessionId: context.sessionId,
        turn: context.turn,
      })
      if (!rolled.ok) return { ok: false, text: rolled.error.message, errorCode: rolled.error.code }
      return {
        ok: true,
        text: `已回退到 ${artifactId} v${rolled.value.revertedTo}，产生新版本 v${rolled.value.version}（state=reverted，${rolled.value.files.length} 个文件）`,
        data: { artifactId, version: rolled.value.version, revertedTo: rolled.value.revertedTo },
      }
    },
  }
}

export function artifactTools(deps: ArtifactToolDeps): readonly { definition: ToolDefinition; handler: ToolHandler }[] {
  return [workdirEditTool(deps), artifactSubmitTool(deps), artifactRollbackTool(deps)]
}
