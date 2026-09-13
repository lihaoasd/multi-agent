import { readdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ErrorCodes } from '../../src/shared/errors.js'
import {
  atomicWriteFile,
  atomicWriteJson,
  ensureInside,
  isPathInside,
  readJson,
} from '../../src/infra/file-store/fs-utils.js'
import { makeTempDir } from '../helpers.js'

let base: string

beforeEach(async () => {
  base = await makeTempDir('fs-')
})
afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('isPathInside / ensureInside', () => {
  it('子路径在内', () => {
    expect(isPathInside(resolve(base), resolve(base, 'a/b.txt'))).toBe(true)
  })

  it('自身在内', () => {
    expect(isPathInside(resolve(base), resolve(base))).toBe(true)
  })

  it('同级兄弟路径越界', () => {
    expect(isPathInside(resolve(base, 'root'), resolve(base, 'other'))).toBe(false)
  })

  it('上级目录越界', () => {
    expect(isPathInside(resolve(base, 'root'), base)).toBe(false)
  })

  it('前缀相似但实为兄弟时越界（root 与 root-2）', () => {
    expect(isPathInside(resolve(base, 'root'), resolve(base, 'root-2/x'))).toBe(false)
  })

  it('目录穿越写法解析后越界', () => {
    expect(isPathInside(resolve(base, 'root'), resolve(base, 'root/../secret'))).toBe(false)
  })

  it('ensureInside 通过并返回规范化绝对路径', () => {
    const target = ensureInside(resolve(base), resolve(base, 'x/y.txt'))
    expect(target).toBe(resolve(base, 'x/y.txt'))
  })

  it('ensureInside 越界抛 ERR_FORBIDDEN_PATH', () => {
    expect(() => ensureInside(resolve(base), resolve(base, '../outside'))).toThrowError(
      expect.objectContaining({ code: ErrorCodes.FORBIDDEN_PATH }),
    )
  })
})

describe('atomicWrite / readJson', () => {
  it('原子写后读回一致（自动建目录）', async () => {
    const f = join(base, 'nested', 'a.json')
    await atomicWriteJson(f, { a: 1 })
    expect(await readJson(f)).toEqual({ a: 1 })
  })

  it('覆盖写后为新内容，且无 .tmp 残留', async () => {
    const f = join(base, 'b.json')
    await atomicWriteJson(f, { v: 1 })
    await atomicWriteJson(f, { v: 2 })
    expect(await readJson(f)).toEqual({ v: 2 })
    const leftover = await readdir(base)
    expect(leftover.filter((n) => n.endsWith('.tmp'))).toHaveLength(0)
  })

  it('readJson 文件不存在返回 null', async () => {
    expect(await readJson(join(base, 'missing.json'))).toBeNull()
  })

  it('atomicWriteFile 支持纯文本', async () => {
    const f = join(base, 't.txt')
    await atomicWriteFile(f, 'hello')
    expect(await readFile(f, 'utf8')).toBe('hello')
  })
})
