/** 测试共享工具：在工作区 .test-tmp/ 下建隔离临时目录（父目录不存在时先创建）。 */
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** 在 .test-tmp/<prefix> 下建临时目录，返回绝对路径。 */
export async function makeTempDir(prefix: string): Promise<string> {
  const parent = join(resolve(process.cwd()), '.test-tmp')
  await mkdir(parent, { recursive: true })
  return mkdtemp(join(parent, prefix))
}
