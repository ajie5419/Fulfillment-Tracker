/** Stable persisted action codes. Display labels may change without migrating todos. */
export const ARRANGE_SEND = 'ARRANGE_SEND'
export const ARRANGE_START = 'ARRANGE_START'
export const SIGN_RELEASE = 'SIGN_RELEASE'
export const CONFIRM_CHANGE = 'CONFIRM_CHANGE'
export const READY_TO_START = 'READY_TO_START'
export const CONFIRM_PLAN_NODE = 'CONFIRM_PLAN_NODE'
export const DO_PLAN_TASK = 'DO_PLAN_TASK'
export const PURCHASE_PLAN_ISSUED = 'PURCHASE_PLAN_ISSUED'
export const DO_DESIGN_TASK = 'DO_DESIGN_TASK'

export const TODO_ACTION_TEXT = {
  [ARRANGE_SEND]: '安排发出',
  [ARRANGE_START]: '安排开工',
  [SIGN_RELEASE]: '签收',
  [CONFIRM_CHANGE]: '确认变更影响',
  [READY_TO_START]: '可以开工',
  [CONFIRM_PLAN_NODE]: '接收计划节点',
  [DO_PLAN_TASK]: '完成部门任务',
  [PURCHASE_PLAN_ISSUED]: '执行采购计划',
  [DO_DESIGN_TASK]: '完成设计任务',
} as const
export type TodoAction = keyof typeof TODO_ACTION_TEXT
export const isTodoAction = (action: string): action is TodoAction => Object.hasOwn(TODO_ACTION_TEXT, action)
export const todoActionText = (action: string) => isTodoAction(action) ? TODO_ACTION_TEXT[action] : action
