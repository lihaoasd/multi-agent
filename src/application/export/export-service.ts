/**
 * 导出服务：将运行时项目文件夹打包 zip（会话/记忆/审批/产物 manifest 等；不含 workdir）。
 * 供 GET /api/projects/:pid/export（api/contract.md §2 系统区）。
 */
import { join, relative } from 'node:path'
import { readdir } from 'node:fs/promises'

export async function collectProjectFiles(
  projectsRoot: string,
  projectId: string,
): Promise<Array<{ path: string; rel: string }>> {
  const root = join(projectsRoot, projectId)
  const files: Array<{ path: string; rel: string }> = []
  await walk(root, root)
  return files

  async function walk(dir: string, base: string): Promise<void> {
    const names = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const n of names) {
      const full = join(dir, n.name)
      if (n.isDirectory()) {
        await walk(full, base)
      } else {
        files.push({ path: full, rel: relative(base, full).split('\\').join('/') })
      }
    }
  }
}
