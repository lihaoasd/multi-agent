/** 测试共享工具：隔离临时目录 + 存储门面装配（重构 P1 起，store 吃 `ProjectStore` 而非路径）。 */
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { createFileStorage } from '../src/infra/store/file-store.js'
import { StorageFacade, type ProjectStore } from '../src/infra/store/project-store.js'

/** 在 .test-tmp/<prefix> 下建临时目录，返回绝对路径。 */
export async function makeTempDir(prefix: string): Promise<string> {
  const parent = join(resolve(process.cwd()), '.test-tmp')
  await mkdir(parent, { recursive: true })
  return mkdtemp(join(parent, prefix))
}

/**
 * 按 **projectsRoot** 建项目作用域门面。
 *
 * 等价于迁移前 `new XStore(projectsRoot)`：store 内部逐调用传 `projectId`，
 * 作用域解析为 `<projectsRoot>/<projectId>`。
 */
export function makeStoreForProjectsRoot(projectsRoot: string): ProjectStore {
  const storage = createFileStorage(projectsRoot)
  return new StorageFacade(storage, storage.root).forProjectsRoot(projectsRoot)
}
