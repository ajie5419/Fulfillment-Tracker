import type { TaskKind } from '../../../shared/plan'
/** 总计划任务事实、节点事实与预测结果的纯数据类型。 */

// ───────────── 部门任务 ─────────────

/** task = 其他任务（部门计划二次分解，plan_task）：4 类记录覆盖不到的部门工作 */
export type { TaskKind } from '../../../shared/plan'

/** 一条挂靠任务的事实（由各类记录换算，见下面的 *Facts） */
export interface TaskFacts {
  kind: TaskKind
  id: string
  /** 不计入（已取消的设计任务、采购行） */
  excluded: boolean
  done: boolean
  /** 完成日（done 时；不知道时为 null，按今天算） */
  doneDay: string | null
  /** 部门自己的日期（比节点日、算预计日用）；工序没填要求完成日时为 null */
  planDay: string | null
}

export interface TaskEstimate {
  /** 预计（完成）日：已完成 = 完成日；没完成 = 自己的日期，已过按今天；没有日期为 null（不影响节点预计日） */
  expectedDay: string | null
  /** 没完成且自己的日期已过 */
  overdue: boolean
  /** 部门日期晚于节点计划日（只提示不拦截，总计划页标红） */
  lateForNode: boolean
}

// ───────────── 节点与前置关系 ─────────────

export interface NodeFacts {
  id: string
  planDay: string
  /** 计划开始日（可选）：有开始日时，前置节点晚到"开始日前一天"之前不推后（中间的空档是余量） */
  startDay?: string | null
  /** 前置节点 ID：null / 不填 = 默认（一级节点等上一个一级节点，子节点没有前置）；[] = 没有前置 */
  preds?: string[] | null
  /** 上级节点 ID（子节点；只有一层）：子节点都完成上级才算完成，子节点晚了上级跟着晚 */
  parent?: string | null
  /** 手动标记完成的完成日（没手动标记为 null） */
  manualDoneDay: string | null
  tasks: TaskFacts[]
}

export interface NodeEstimate {
  id: string
  done: boolean
  /** 怎么完成的：MANUAL 手动标记，AUTO 挂靠任务（和子节点）全部完成 */
  doneBy: 'MANUAL' | 'AUTO' | null
  actualDay: string | null
  expectedDay: string
  /** 预计日 - 计划日（天，正数 = 晚；完成的节点是 实际 - 计划） */
  delayDays: number
  /** 预计日由什么决定：self 自身计划日 / task 挂靠任务 / prev 前置节点顺延 / today 计划日已过 / actual 已完成 */
  driver: 'self' | 'task' | 'prev' | 'today' | 'actual'
  /** 不计前置顺延的自身预计日（完成的 = 实际完成日） */
  selfExpectedDay: string
  /** 自身延误天数 = 自身预计日 - 计划日（没完成且 > 0 才算源头） */
  selfDelayDays: number
  /** 自身预计日由什么决定：self / task / today / actual */
  selfDriver: 'self' | 'task' | 'today' | 'actual'
  /** 源头延误节点：没完成、自身就已延误 */
  source: boolean
  /** 受上游影响：没完成，且前置顺延后比自身预计日更晚 */
  upstream: boolean
  /** 实际用的前置节点 ID（默认的"上一个节点"也解析出来） */
  preds: string[]
  /** 推后是哪个前置节点（或子节点）造成的（driver = prev 时） */
  pushedBy: string | null
  /** 子节点 ID（按顺序） */
  children: string[]
  /**
   * 余量：这个节点还能再晚几天而不推迟预计交期（按前置关系从最后一个节点往前推）。
   * ≤ 0 = 关键节点（再晚就拖交期；负数 = 已经让交期晚了这么多天）；null = 已完成，或者后面没有节点接着它（不影响交期）。
   */
  slackDays: number | null
  /** 计入的挂靠任务数（不含已取消）、其中完成的、超期的、日期晚于节点的 */
  taskCount: number
  doneCount: number
  overdueCount: number
  lateCount: number
  tasks: (TaskFacts & TaskEstimate)[]
}

export interface PlanForecast {
  nodes: NodeEstimate[]
  /** 对应交期的节点 = 最后一个一级节点 */
  lastNodeId: string | null
  /** 预计交期 = 最后一个一级节点的预计日；没有节点为 null */
  expectedDelivery: string | null
  /** 预计交期 - QMS 交期（天，正数 = 拖期）；没有节点为 null */
  deliveryDelayDays: number | null
  /** 延误节点：没完成、预计日晚于计划日（含只因前置顺延的） */
  delayedNodes: number
  /** 源头延误节点：没完成、自身就已延误（看板、总览、每日汇总的"延误节点数"按这个口径） */
  sourceNodes: number
}
