import type { FileStore, RelPath } from '../../ports/file-store'
import type { ProjectId, ProjectStore } from '../../ports/project'
import type { ArchiveEntry, ArchiveWriter, ProjectExporter } from '../../ports/runtime'
import { err, ok } from '../../shared/result'

/**
 * 项目导出（`GET /api/projects/:pid/export`，contract.md §系统）：
 * 把运行时项目文件夹（会话日志/记忆/manifest/归属/任务/询问/编排图/产出物版本）打包为 zip。
 * **只导出平台数据，不动用户工作目录**（prd FR-01 口径一致）。
 */

export interface ProjectExporterOptions {
  readonly fileStore: FileStore
  readonly projects: ProjectStore
  readonly zip: ArchiveWriter
  readonly dataDir: RelPath
  /** 单次导出体积上限（字符数），超过即拒绝，避免把进程内存打满 */
  readonly maxChars?: number
}

const TEXT_EXTENSIONS = ['.json', '.jsonl', '.md', '.txt', '.yaml', '.yml', '.patch', '.log']

function isTextual(name: string): boolean {
  const lower = name.toLowerCase()
  return TEXT_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

export function createProjectExporter(options: ProjectExporterOptions): ProjectExporter {
  const maxChars = options.maxChars ?? 64 * 1024 * 1024

  const collect = async (dir: RelPath, prefix: string, files: ArchiveEntry[], budget: { used: number }): Promise<void> => {
    const listed = await options.fileStore.list(dir)
    if (!listed.ok) return
    for (const entry of listed.value) {
      const path = `${dir}/${entry.name}`
      const relative = `${prefix}${entry.name}`
      if (entry.isDirectory) {
        await collect(path, `${relative}/`, files, budget)
        continue
      }
      if (!isTextual(entry.name)) continue
      const text = await options.fileStore.readText(path)
      if (!text.ok) continue
      budget.used += text.value.length
      if (budget.used > maxChars) throw new Error('项目数据过大，导出被拒绝')
      files.push({ path: relative, content: text.value })
    }
  }

  return {
    async export(projectId: ProjectId) {
      const project = await options.projects.get(projectId)
      if (!project.ok) return project
      const dir = `${options.dataDir}/projects/${projectId}`
      const exists = await options.fileStore.exists(dir)
      if (!exists) {
        return err('ERR_NOT_FOUND', `项目数据目录不存在：${projectId}`, { projectId })
      }

      const files: ArchiveEntry[] = []
      const budget = { used: 0 }
      try {
        // 先放一份导出说明，便于人工确认来源与范围
        files.push({
          path: 'EXPORT-README.txt',
          content: [
            `Agent Haness 项目导出`,
            `项目：${project.value.name}（${projectId}）`,
            `导出时间：${new Date().toISOString()}`,
            `范围：运行时项目文件夹（会话日志 / 记忆 / 产出物 manifest 与版本 / 归属表 / 任务 / 询问 / 编排图）`,
            `不含：用户工作目录（${project.value.workdir}）`,
            '',
          ].join('\n'),
        })
        await collect(dir, '', files, budget)
      } catch (cause) {
        return err('ERR_VALIDATION', cause instanceof Error ? cause.message : String(cause), { projectId })
      }

      const buffer = options.zip.build(files)
      return ok({ fileName: `${projectId}.zip`, bytes: buffer.length, content: buffer })
    },
  }
}
