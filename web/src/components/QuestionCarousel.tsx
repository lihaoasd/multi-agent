import { Button, Input, Space, Tag, Typography } from 'antd'
import { useState } from 'react'
import type { QuestionRecord } from '../api/work'
import {
  answeredCount,
  canSubmit,
  stepCursor,
  swipeDirection,
  toAnswerPayload,
  withAnswer,
  type AnswerMap,
} from '../lib/question-wizard'

/**
 * 询问卡（S33）：**一次一个问题、卡片左右滑动**。
 *
 * - 逐题作答（有选项点按钮、无选项填文本），答完自动前进；左右滑动或点箭头切题；
 * - **攒齐后一次提交**——后端 `answer()` 一被调用就立刻唤醒 Agent，逐题提交会让它带着半份答复继续跑；
 * - 滑动用 pointer 事件实现：**按在按钮上不启动拖拽**（S17 的指针捕获教训），并在两端夹住不循环。
 */

const SWIPE_THRESHOLD = 60

export function QuestionCarousel({
  question,
  onSubmit,
}: {
  readonly question: QuestionRecord
  readonly onSubmit: (
    answers: readonly { readonly itemId: string; readonly choice?: string | null; readonly text?: string | null }[],
  ) => Promise<void>
}) {
  const [cursor, setCursor] = useState(0)
  const [answers, setAnswers] = useState<AnswerMap>({})
  const [draft, setDraft] = useState('')
  const [dragX, setDragX] = useState(0)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const total = question.items.length
  const item = question.items[Math.min(cursor, Math.max(total - 1, 0))]
  const answered = answeredCount(question, answers)
  const ready = canSubmit(question, answers)

  const answer = (draftAnswer: { choice?: string; text?: string }): void => {
    if (item === undefined) return
    setAnswers((previous) => withAnswer(previous, item.id, draftAnswer))
    setDraft('')
    setCursor((current) => stepCursor(current, 1, total))
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const target = event.target
    if (target instanceof HTMLElement && target.closest('button') !== null) return
    setDragFrom(event.clientX)
    setDragX(0)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragFrom === null) return
    setDragX(event.clientX - dragFrom)
  }

  const onPointerUp = (): void => {
    if (dragFrom === null) return
    const direction = swipeDirection(dragX, SWIPE_THRESHOLD)
    setDragFrom(null)
    setDragX(0)
    if (direction !== 0) setCursor((current) => stepCursor(current, direction, total))
  }

  if (item === undefined) return null

  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      await onSubmit(toAnswerPayload(question, answers))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      style={{
        border: '1px solid #91caff',
        background: '#f0f8ff',
        borderRadius: 6,
        padding: 8,
        touchAction: 'pan-y',
        cursor: total > 1 ? 'grab' : 'default',
        transform: `translateX(${dragX}px)`,
        transition: dragFrom === null ? 'transform 120ms ease-out' : 'none',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <Space size={6} wrap>
        <Typography.Text strong>{`${question.asker}：${question.title}`}</Typography.Text>
        <Tag>{`第 ${cursor + 1}/${total} 题`}</Tag>
        <Typography.Text type="secondary">{`已答 ${answered}/${total}`}</Typography.Text>
        {answers[item.id] !== undefined && <Tag color="green">已答，可重新选择</Tag>}
      </Space>

      <div style={{ marginTop: 8 }}>
        <Typography.Text>{item.text}</Typography.Text>
      </div>

      <div style={{ marginTop: 8 }}>
        {item.options.length > 0 ? (
          <Space size={6} wrap>
            {item.options.map((option) => (
              <Button
                key={option}
                size="small"
                type={answers[item.id]?.choice === option ? 'primary' : 'default'}
                onClick={() => answer({ choice: option })}
              >
                {option}
              </Button>
            ))}
          </Space>
        ) : (
          <Space size={6} wrap>
            <Input
              size="small"
              style={{ width: 280 }}
              placeholder="输入你的答复（回车即答，答完自动到下一题）"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onPressEnter={() => {
                if (draft.trim().length > 0) answer({ text: draft.trim() })
              }}
            />
            <Button size="small" disabled={draft.trim().length === 0} onClick={() => answer({ text: draft.trim() })}>
              作答
            </Button>
          </Space>
        )}
      </div>

      <Space size={6} wrap style={{ marginTop: 10 }}>
        <Button size="small" disabled={cursor === 0} onClick={() => setCursor((current) => stepCursor(current, -1, total))}>
          ‹ 上一题
        </Button>
        <Button
          size="small"
          disabled={cursor >= total - 1}
          onClick={() => setCursor((current) => stepCursor(current, 1, total))}
        >
          下一题 ›
        </Button>
        <Button size="small" type="primary" loading={busy} disabled={!ready} onClick={() => void submit()}>
          {ready ? '提交答复' : '答完全部必答题后可提交'}
        </Button>
        {total > 1 && <Typography.Text type="secondary">提示：卡片可左右滑动切题</Typography.Text>}
      </Space>
    </div>
  )
}
