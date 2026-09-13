/**
 * 摘要引擎（M5 L2）：滚动摘要（memory.md §3.1）。
 * MVP 规则式（Mock 阶段无模型文本）：窗口消息 → 抽取要点文本 → 写 summary 事件并登记 meta.summaryRefs。
 * 真实模型生成留 M8；事件/字段契约与设计一致（digest 结构化字段）。
 */
import { nowIso } from '../../shared/util/id.js'
import type { SessionMeta, SessionLogEvent } from '../../shared/types/session.js'
import { SessionStore } from '../session/session-store.js'

/** 触发：距上次摘要新增消息条数阈值。 */
const SUMMARY_EVERY = 20

export class SummaryEngine {
  constructor(private readonly store: SessionStore) {}

  /** 回合结束/事件追加后调用；达到阈值则生成滚动摘要。 */
  async maybeSummarize(meta: SessionMeta): Promise<void> {
    const since = this.sinceLast(meta)
    if (since < SUMMARY_EVERY) return
    const window = await this.store.readWindow(meta.projectId, meta.id, { limit: SUMMARY_EVERY })
    const digest = this.digest(window)
    const summaryId = `s_${nowIso().replace(/\D/g, '').slice(2, 14)}_${meta.lastSeq}`
    const ofSeq = window.length > 0 ? window[0]!.seq : meta.lastSeq + 1
    const toSeq = meta.lastSeq
    const summaryEvt = await this.store.appendEvent(meta, {
      kind: 'summary',
      role: 'system',
      payload: { summaryId, ofSeq, toSeq, digest },
    })
    meta.summaryRefs.push({ seq: summaryEvt.seq, summaryId, ofSeq, toSeq })
    await this.store.writeMeta(meta).catch(() => undefined)
  }

  /** 距上次摘要(或会话开始)的消息事件数。 */
  private sinceLast(meta: SessionMeta): number {
    if (meta.summaryRefs.length === 0) return meta.lastSeq
    const last = meta.summaryRefs[meta.summaryRefs.length - 1]!
    return meta.lastSeq - last.toSeq
  }

  /** MVP 规则式摘要：列出最近的用户问题/关键工具与结论行。 */
  private digest(events: SessionLogEvent[]): Record<string, string> {
    const lines: string[] = []
    for (const e of events) {
      if (e.kind === 'message' && e.role === 'user' && e.content?.text) {
        lines.push(`问题: ${cut(e.content.text, 120)}`)
      } else if (e.kind === 'message' && e.role === 'agent' && e.content?.text) {
        lines.push(`结论: ${cut(e.content.text, 120)}`)
      } else if (e.kind === 'artifact') {
        lines.push(`产出物: ${JSON.stringify(e.payload ?? {}).slice(0, 80)}`)
      }
    }
    return {
      主题: '会话滚动摘要（规则式，M5 MVP）',
      关键信息: lines.slice(-8).join(' | ') || '(仅工具事件)',
      待办: '详见会话原文（真实摘要引擎 M8 接入）',
    }
  }
}

function cut(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}
