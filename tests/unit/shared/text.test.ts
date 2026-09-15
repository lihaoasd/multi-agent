import { describe, expect, it } from 'vitest'
import { cjkChars, findSpans, normalizeForSearch, snippetAround, tokenize } from '../../../src/shared/text'

/** 规则 7：中文检索的 2-gram 命中与边界（标点/换行/空白） */
describe('shared/text · 分词（规则 7）', () => {
  it('连续汉字取 2-gram', () => {
    expect(tokenize('登录模块')).toEqual(['登录', '录模', '模块'])
  })

  it('标点、空白与换行都是词元边界（不跨边界成组）', () => {
    expect(tokenize('登录，模块')).toEqual(['登录', '模块'])
    expect(tokenize('登录\n模块')).toEqual(['登录', '模块'])
    expect(tokenize('登录 模块')).toEqual(['登录', '模块'])
    expect(tokenize('登录。\r\n模块')).toEqual(['登录', '模块'])
  })

  it('单字汉字回退为单字词元；ASCII 整词长度 ≥2 才索引', () => {
    expect(tokenize('登')).toEqual(['登'])
    expect(tokenize('Login 模块 A')).toEqual(['login', '模块'])
  })

  it('中英混排：字母数字整词与汉字 2-gram 并存', () => {
    expect(tokenize('用 vite 构建')).toEqual(['用', 'vite', '构建'])
  })

  it('重复词元去重（同一文档不重复计数）', () => {
    expect(tokenize('登录登录')).toEqual(['登录', '录登'])
  })

  it('归一化：全角转半角 + 小写', () => {
    expect(normalizeForSearch('ＬＯＧＩＮ')).toBe('login')
    expect(normalizeForSearch('A\r\nB')).toBe('a\nb')
  })

  it('cjkChars：只保留汉字且去重（字符回退用）', () => {
    expect(cjkChars('登录模块 vite 登录')).toEqual(['登', '录', '模', '块'])
  })

  it('findSpans：合并重叠/相邻区间，返回升序不重叠区间', () => {
    expect(findSpans('登录模块', ['登录', '模块'])).toEqual([[0, 4]])
    expect(findSpans('登录，模块', ['登录', '模块'])).toEqual([
      [0, 2],
      [3, 5],
    ])
  })

  it('snippetAround：以首个命中为中心截取并加省略号', () => {
    const text = `${'前'.repeat(200)}登录模块${'后'.repeat(200)}`
    const snippet = snippetAround(text, ['登录模块'], 60)
    expect(snippet).toContain('登录模块')
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet.length).toBeLessThanOrEqual(62)
  })
})
