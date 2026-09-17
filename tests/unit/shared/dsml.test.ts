import { describe, expect, it } from 'vitest'
import { extractDsmlToolCalls, hasDsml } from '../../../src/shared/dsml'

/**
 * DSML 文本工具调用兼容（S30）。
 *
 * ⚠️ 用例里的标记**不直接写字面量**，而是由 `tag()` 拼出来：这段协议标记本身很容易在
 * 编辑/复制时被"当成真的工具调用"误伤（本次开发中就踩到过），拼装写法更安全也更好读。
 *
 * 事故原型：`data/projects/p_mu5gx818j5qh9/sessions/u_pm_1.log.jsonl` 第 42 条消息——
 * 模型在"没带 tools 的追问"里把 `ask_user` 写成了 DSML 文本，与结论文本混在同一条消息里。
 */

/** 拼一个 DSML 标签：`tag('invoke', ' name="ask_user"')` */
function tag(name: string, attrs = '', closing = false): string {
  return `<${closing ? '/' : ''}|${'|'}D${'SML'}${'|'}| ${name}${attrs}>`
}

describe('shared/dsml · 从正文里提取工具调用', () => {
  it('无 DSML 时原样返回（快路径）', () => {
    const text = '第 1 步：先读目录。\n一切正常。'
    expect(hasDsml(text)).toBe(false)
    expect(extractDsmlToolCalls(text)).toEqual({ text, calls: [], unparsed: 0 })
  })

  it('提取单次调用：工具名 + JSON 参数，并从正文剥离标记', () => {
    const text = [
      '第 1 步「需求澄清」：',
      tag('tool_calls'),
      tag('invoke', ' name="ask_user"'),
      tag('parameter', ' name="questions" string="false"') +
        '[{"question":"做成哪种形态？","options":["网页版","终端版"]}]' +
        tag('parameter', '', true),
      tag('invoke', '', true),
      tag('tool_calls', '', true),
      '',
      '第 2 步：等你答复后再写需求说明。',
    ].join('\n')

    expect(hasDsml(text)).toBe(true)
    const result = extractDsmlToolCalls(text)
    expect(result.unparsed).toBe(0)
    expect(result.calls).toHaveLength(1)
    expect(result.calls[0]?.name).toBe('ask_user')
    expect(result.calls[0]?.args).toEqual({
      questions: [{ question: '做成哪种形态？', options: ['网页版', '终端版'] }],
    })
    expect(result.text).toContain('第 1 步「需求澄清」：')
    expect(result.text).toContain('第 2 步：等你答复后再写需求说明。')
    expect(result.text).not.toContain('D' + 'SML')
  })

  it('多个调用 + 多参数都提取；JSON 参数解析成对象、其余保留字符串', () => {
    const text = [
      '先说明：',
      tag('tool_calls'),
      tag('invoke', ' name="fs_read_file"'),
      tag('parameter', ' name="path"') + 'src/a.ts' + tag('parameter', '', true),
      tag('parameter', ' name="limit"') + '20' + tag('parameter', '', true),
      tag('invoke', '', true),
      tag('invoke', ' name="task_assign"'),
      tag('parameter', ' name="title"') + '实现登录' + tag('parameter', '', true),
      tag('invoke', '', true),
      tag('tool_calls', '', true),
      '',
      '中间一段解释。',
    ].join('\n')

    const result = extractDsmlToolCalls(text)
    expect(result.calls.map((call) => call.name)).toEqual(['fs_read_file', 'task_assign'])
    expect(result.calls[0]?.args).toEqual({ path: 'src/a.ts', limit: '20' })
    expect(result.calls[1]?.args).toEqual({ title: '实现登录' })
    expect(result.text).toContain('先说明：')
    expect(result.text).toContain('中间一段解释。')
    expect(result.text).not.toContain('D' + 'SML')
  })

  it('全角竖线的写法同样识别（含外层 tool_calls 包裹）', () => {
    const fullWidth = (name: string, attrs = '', closing = false): string =>
      `<${closing ? '/' : ''}｜｜D${'SML'}｜｜ ${name}${attrs}>`
    const text = [
      '答复：',
      fullWidth('tool_calls'),
      fullWidth('invoke', ' name="ask_user"'),
      fullWidth('parameter', ' name="title"') + '继续？' + fullWidth('parameter', '', true),
      fullWidth('invoke', '', true),
      fullWidth('tool_calls', '', true),
    ].join('\n')

    const result = extractDsmlToolCalls(text)
    expect(result.calls).toHaveLength(1)
    expect(result.calls[0]?.name).toBe('ask_user')
    expect(result.calls[0]?.args).toEqual({ title: '继续？' })
    expect(result.text).toContain('答复：')
  })

  it('容错：省略外层包裹的裸 invoke 也认（模型偶尔少写一层）', () => {
    const text = ['答复：', tag('invoke', ' name="ask_user"'), tag('parameter', ' name="title"') + '继续？' + tag('parameter', '', true), tag('invoke', '', true)].join('\n')
    const result = extractDsmlToolCalls(text)
    expect(result.calls.map((call) => call.name)).toEqual(['ask_user'])
    expect(result.calls[0]?.args).toEqual({ title: '继续？' })
  })

  it('残缺 / 无法解析的片段：照样剥离，并计入 unparsed（供诊断，不让脏标记落进会话）', () => {
    const text = ['结论如下。', tag('invoke', ' name=""'), '（没有参数、没有闭合）', tag('tool_calls', '', true)].join('\n')
    const result = extractDsmlToolCalls(text)
    expect(result.calls).toHaveLength(0)
    expect(result.unparsed).toBeGreaterThan(0)
    expect(result.text).toContain('结论如下。')
    expect(result.text).not.toContain('D' + 'SML')
  })
})
