/**
 * 任务栏视图规则（纯函数，无构建 ESM，页面与单测共用）：
 * - 右栏「任务栏」只列**活跃任务**（进行中 / 待领取）；
 * - 任务栏面板固定**三列**：待领取 / 进行中 / 已结束（完成·受阻·终止）。
 */

/** 右栏任务栏只显示这两类（其余看面板）。 */
export const ACTIVE_STATES = ['todo', 'in_progress']

/** 右栏排序权重：进行中在前（正在干活），其次待领取。 */
const ACTIVE_RANK = { in_progress: 0, todo: 1 }

function byTimeDesc(a, b) {
  return String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))
}

/** 活跃任务（进行中 + 待领取），进行中优先、组内按更新时间倒序。 */
export function activeTasks(tasks) {
  return (tasks ?? [])
    .filter((t) => ACTIVE_STATES.includes(t.state))
    .sort((a, b) => {
      const d = (ACTIVE_RANK[a.state] ?? 9) - (ACTIVE_RANK[b.state] ?? 9)
      return d !== 0 ? d : byTimeDesc(a, b)
    })
}

/**
 * 面板三列定义。第三列的 `states` 顺序即列内排序（受阻优先——需要关注，
 * 然后已完成、已终止）；每张卡片仍显示自己的准确状态。
 */
export const BOARD_COLUMNS = [
  { key: 'todo', title: '待领取（已发布）', states: ['todo'] },
  { key: 'in_progress', title: '进行中', states: ['in_progress'] },
  { key: 'closed', title: '已结束（完成 · 受阻 · 终止）', states: ['blocked', 'done', 'terminated'] },
]

/** 按三列分组（始终返回 3 列，空列也在，保证面板布局稳定）。 */
export function groupBoardTasks(tasks) {
  const all = tasks ?? []
  return BOARD_COLUMNS.map((col) => ({
    key: col.key,
    title: col.title,
    tasks: all
      .filter((t) => col.states.includes(t.state))
      .sort((a, b) => {
        const d = col.states.indexOf(a.state) - col.states.indexOf(b.state)
        return d !== 0 ? d : byTimeDesc(a, b)
      }),
  }))
}

/** 各状态条数（面板顶部统计用）。 */
export function countByState(tasks) {
  const out = {}
  for (const t of tasks ?? []) out[t.state] = (out[t.state] ?? 0) + 1
  return out
}
