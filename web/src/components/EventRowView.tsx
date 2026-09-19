import { Collapse, Typography } from 'antd'
import { memo } from 'react'
import { Markdown } from './Markdown'
import { eventRow, isToolFailed, messageTextOf, type EventLike } from '../lib/event-display'

/**
 * 会话流里的**一行**（S48/D51）。
 *
 * 为什么要单独抽出来并 `memo`：会话流会随事件不断增长，而每次 `setEvents`（新消息/工具结果…）
 * 都会触发整段重渲染——对话消息还要走 `react-markdown` 解析（S27），几十条历史消息被反复重解析
 * 是实打实的卡顿来源。按 `event` 记忆化后，追加新事件只渲染新那一行，历史行原地复用。
 * 纯展示组件：不持有状态、不订阅实时通道（帧处理仍在页面上）。
 */
export interface EventRowViewProps {
  readonly event: EventLike
}

function EventRowViewInner({ event }: EventRowViewProps): React.ReactElement {
  if (event.kind === 'message') {
    const role = String(event.payload['role'] ?? '')
    const align = role === 'user' ? 'flex-end' : 'flex-start'
    const background = role === 'user' ? '#e6f4ff' : '#f6ffed'
    return (
      <div style={{ display: 'flex', justifyContent: align }}>
        <div style={{ background, borderRadius: 6, padding: '6px 10px', maxWidth: '80%', whiteSpace: 'pre-wrap' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            #{event.seq} · {event.kind}
            {role.length > 0 ? ` · ${role}` : ''} · turn {event.turn}
          </Typography.Text>
          {/* S23/S27：对话消息按 Markdown 渲染（框架渲染，不注入 HTML） */}
          <Markdown text={messageTextOf(event)} />
        </div>
      </div>
    )
  }

  // S22：思考 / 工具调用 / 工具结果 / 错误 / 计划直接内联展示（不折叠成"工作日志"）
  // S24：字段名与生产者 strategies.ts 对齐；S26：工具结果条目只显示工具名
  const failed = isToolFailed(event)
  const row = eventRow(event)
  const tone =
    event.kind === 'error' || failed
      ? { background: '#fff2f0', border: '1px solid #ffccc7' }
      : event.kind === 'tool_call'
        ? { background: '#f0f5ff', border: '1px solid #d6e4ff' }
        : event.kind === 'plan'
          ? // S44/D47：计划行给一档独立底色，作为各步之间可见的分界
            { background: '#f9f0ff', border: '1px solid #efdbff' }
          : { background: '#fafafa', border: '1px solid #f0f0f0' }
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
      <div style={{ ...tone, borderRadius: 6, padding: '4px 8px', maxWidth: '85%', whiteSpace: 'pre-wrap', fontSize: 12 }}>
        {row.showMeta ? (
          row.bodyMode === 'collapsed' ? (
            // S28：工具调用参数默认折叠；S41/D44：思考正文同样默认折叠
            <Collapse
              ghost
              size="small"
              style={{ background: 'transparent' }}
              items={[
                {
                  key: String(event.seq),
                  label: (
                    <Typography.Text style={{ fontSize: 12 }}>
                      {row.label} · #{event.seq} · turn {event.turn}
                    </Typography.Text>
                  ),
                  children: (
                    <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                      {row.body}
                    </pre>
                  ),
                },
              ]}
            />
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {row.label} · #{event.seq} · turn {event.turn}
            </Typography.Text>
          )
        ) : (
          <span style={{ fontWeight: failed ? 600 : 400 }}>{row.label}</span>
        )}
        {row.body !== null && row.bodyMode === 'inline' && <div style={{ whiteSpace: 'pre-wrap' }}>{row.body}</div>}
      </div>
    </div>
  )
}

export const EventRowView = memo(EventRowViewInner)
