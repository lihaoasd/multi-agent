import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { browseDirectory } from '../src/application/fs-browse/fs-browse-service.js'
import { ErrorCodes } from '../src/shared/errors.js'
import { makeTempDir } from './helpers.js'

let base: string

beforeEach(async () => {
  base = await makeTempDir('browse-')
})
afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('browseDirectory', () => {
  it('列出目录内容：文件与目录', async () => {
    await mkdir(join(base, 'sub'))
    await writeFile(join(base, 'a.txt'), 'a')
    const res = await browseDirectory({ path: base, depth: 0 })
    expect(res.entries.map((e) => e.name).sort()).toEqual(['a.txt', 'sub'])
    const dir = res.entries.find((e) => e.name === 'sub')!
    expect(dir.type).toBe('dir')
    const file = res.entries.find((e) => e.name === 'a.txt')!
    expect(file.type).toBe('file')
  })

  it('默认过滤隐藏与系统目录，includeHidden 放行', async () => {
    await mkdir(join(base, '.git'))
    await mkdir(join(base, 'docs'))
    await writeFile(join(base, '.env'), 'x')
    const hidden = await browseDirectory({ path: base, depth: 0 })
    expect(hidden.entries.map((e) => e.name)).toEqual(['docs'])
    const all = await browseDirectory({ path: base, depth: 0, includeHidden: true })
    expect(all.entries.map((e) => e.name).sort()).toEqual(['.env', '.git', 'docs'])
  })

  it('depth 递归列出子树', async () => {
    await mkdir(join(base, 'a', 'b'), { recursive: true })
    await writeFile(join(base, 'a', 'b', 'c.txt'), 'c')
    const res = await browseDirectory({ path: base, depth: 2 })
    expect(res.entries.some((e) => e.path.endsWith('c.txt'))).toBe(true)
  })

  it('相对路径拒绝', async () => {
    await expect(browseDirectory({ path: 'relative/dir' })).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION,
    })
  })

  it('不存在路径 → ERR_NOT_FOUND；文件路径 → ERR_VALIDATION', async () => {
    await expect(browseDirectory({ path: join(base, 'nope') })).rejects.toMatchObject({
      code: ErrorCodes.NOT_FOUND,
    })
    const f = join(base, 'file.txt')
    await writeFile(f, 'x')
    await expect(browseDirectory({ path: f })).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION,
    })
  })
})
