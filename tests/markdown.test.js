/**
 * Markdown 渲染单测（web/markdown.js，纯函数）：转义安全 + 受控语法子集。
 * 说明：前端为无构建 ESM，渲染器与页面共用同一文件，故直接 import 真实实现。
 */
import { describe, expect, it } from 'vitest'

import { renderMarkdown } from '../web/markdown.js'

describe('Markdown 渲染：安全转义', () => {
  it('HTML 标签与脚本被转义，不产生可执行标记', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;img')
  })

  it('危险协议的链接不生成 <a>', () => {
    const html = renderMarkdown(
      '[点我](javascript:alert(1)) 与 [正常](https://example.com/a?b=1&c=2)',
    )
    // 危险链接按纯文本保留（不生成 href），安全链接正常生成
    expect(html).not.toContain('href="javascript')
    expect(html).toContain('[点我](javascript:alert(1))')
    expect(html).toContain('href="https://example.com/a?b=1&amp;c=2"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('行内代码/代码块内容保持转义且无占位符泄漏', () => {
    const inline = renderMarkdown('用 `a<b` 比较')
    expect(inline).toContain('<code>a&lt;b</code>')
    const block = renderMarkdown('```html\n<b>粗</b>\n```')
    expect(block).toContain('<pre><code class="lang-html">')
    expect(block).toContain('&lt;b&gt;粗&lt;/b&gt;')
    expect(inline).not.toMatch(/\u0000/)
    expect(block).not.toMatch(/\u0000/)
  })
})

describe('Markdown 渲染：块级语法', () => {
  it('标题 / 分割线 / 引用', () => {
    expect(renderMarkdown('# 一级')).toContain('<h1>一级</h1>')
    expect(renderMarkdown('### 三级')).toContain('<h3>三级</h3>')
    expect(renderMarkdown('---')).toContain('<hr>')
    expect(renderMarkdown('> 引用内容')).toContain('<blockquote>引用内容</blockquote>')
  })

  it('无序/有序列表（含缩进续行）', () => {
    const ul = renderMarkdown('- 甲\n- 乙')
    expect(ul).toContain('<ul><li>甲</li><li>乙</li></ul>')
    const ol = renderMarkdown('1. 第一\n2. 第二')
    expect(ol).toContain('<ol><li>第一</li><li>第二</li></ol>')
    const cont = renderMarkdown('- 一项\n  续行说明')
    expect(cont).toContain('<li>一项<br>续行说明</li>')
  })

  it('管道表格', () => {
    const html = renderMarkdown('| 项 | 值 |\n| --- | --- |\n| a | 1 |')
    expect(html).toContain('<table>')
    expect(html).toContain('<th>项</th>')
    expect(html).toContain('<td>1</td>')
  })

  it('段落内的单换行渲染为 <br>', () => {
    expect(renderMarkdown('第一行\n第二行')).toContain('<p>第一行<br>第二行</p>')
  })
})

describe('Markdown 渲染：行内语法', () => {
  it('粗体/斜体/删除线/链接', () => {
    const html = renderMarkdown('**粗** 与 *斜* 与 ~~删~~ 与 [链接](https://a.dev)')
    expect(html).toContain('<strong>粗</strong>')
    expect(html).toContain('<em>斜</em>')
    expect(html).toContain('<del>删</del>')
    expect(html).toContain('<a href="https://a.dev"')
  })

  it('任务分派脚注（列表 + 加粗）可正常渲染', () => {
    const html = renderMarkdown(
      '结论如下。\n\n【系统 · 任务分派】\n- ✅ 任务 t_1「实现登录」→ dev_1（已开始执行）',
    )
    expect(html).toContain('<p>结论如下。</p>')
    expect(html).toContain('<li>✅ 任务 t_1「实现登录」→ dev_1（已开始执行）</li>')
  })
})
