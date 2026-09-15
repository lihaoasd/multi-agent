import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDirectoryBrowser } from '../../../src/infra/fs/directory-browser'

describe('infra/directory-browser', () => {
  it('浏览目录：默认过滤隐藏项，目录优先排序，标记 git 仓库', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ah-browse-'))
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, '.hidden'))
    mkdirSync(join(root, 'repo', '.git'), { recursive: true })
    writeFileSync(join(root, 'README.md'), '# demo')

    const browser = createDirectoryBrowser()
    const result = await browser.browse(root)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const names = result.value.entries.map((entry) => entry.name)
    expect(names).toEqual(['repo', 'src', 'README.md'])
    expect(names).not.toContain('.hidden')
    expect(result.value.entries.find((entry) => entry.name === 'repo')?.isRepo).toBe(true)
    expect(result.value.entries.find((entry) => entry.name === 'src')?.isRepo).toBe(false)
    expect(result.value.parent).not.toBeNull()
  })

  it('includeHidden=true 时包含隐藏项并标注 hidden', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ah-browse-'))
    mkdirSync(join(root, '.config'))
    const browser = createDirectoryBrowser()
    const result = await browser.browse(root, { includeHidden: true })
    expect(result.ok && result.value.entries.map((entry) => entry.name)).toEqual(['.config'])
    expect(result.ok && result.value.entries[0]?.hidden).toBe(true)
  })

  it('不存在的目录 → ERR_NOT_FOUND；相对路径 → ERR_VALIDATION', async () => {
    const browser = createDirectoryBrowser()
    const missing = await browser.browse(join(tmpdir(), 'ah-not-exist-xyz'))
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('ERR_NOT_FOUND')

    const relative = await browser.browse('relative/path')
    expect(relative.ok).toBe(false)
    if (!relative.ok) expect(relative.error.code).toBe('ERR_VALIDATION')
  })

  it('inspectWorkdir：空目录=empty，含内容/含 .git=existing-repo，缺失=exists:false', async () => {
    const browser = createDirectoryBrowser()
    const empty = mkdtempSync(join(tmpdir(), 'ah-empty-'))
    const emptyInspection = await browser.inspectWorkdir(empty)
    expect(emptyInspection.ok && emptyInspection.value).toMatchObject({
      exists: true,
      isDirectory: true,
      writable: true,
      kind: 'empty',
    })

    const withGit = mkdtempSync(join(tmpdir(), 'ah-repo-'))
    mkdirSync(join(withGit, '.git'))
    const repoInspection = await browser.inspectWorkdir(withGit)
    expect(repoInspection.ok && repoInspection.value.kind).toBe('existing-repo')

    const withFiles = mkdtempSync(join(tmpdir(), 'ah-files-'))
    writeFileSync(join(withFiles, 'package.json'), '{}')
    const filesInspection = await browser.inspectWorkdir(withFiles)
    expect(filesInspection.ok && filesInspection.value.kind).toBe('existing-repo')

    const missing = await browser.inspectWorkdir(join(tmpdir(), 'ah-ghost-xyz'))
    expect(missing.ok && missing.value.exists).toBe(false)
  })

  it('返回规范化后的绝对路径（供上层做前缀判定）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ah-path-'))
    const browser = createDirectoryBrowser()
    const result = await browser.inspectWorkdir(root)
    expect(result.ok && result.value.path).toBe(root)
  })
})
