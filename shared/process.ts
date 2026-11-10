export type ProcessKind = 'MATERIAL' | 'PROCESS'
export type ProcessAction = 'start' | 'issue' | 'revise' | 'reset'

/** Route by source nodes; exact names preserve drawing tasks such as commissioning drawings. */
export const PROCUREMENT_PLAN_NODE_MARKER = '采购计划'
export const PROCESS_EXCLUDED_NODE_NAMES = ['调试'] as const
export const requiresProcessForNode = (name?: string | null) =>
  !name?.includes(PROCUREMENT_PLAN_NODE_MARKER) && !PROCESS_EXCLUDED_NODE_NAMES.some(nodeName => nodeName === name)

/** 只有向前编制、下发需要有效发放单；修改、撤回始终允许回退。前后端共用文案。 */
export function processReleaseBlockReason(kind: ProcessKind, action: ProcessAction, released: boolean): string | null {
  if (released || (action !== 'start' && action !== 'issue')) return null
  return `图纸未发放，不能${action === 'start' ? '开始编制' : '下发'}${kind === 'MATERIAL' ? '料单' : '工艺'}`
}

/** 料单状态。 */
export const MATERIAL_STATUS_TEXT = { NOT_STARTED: '未开始', DRAFTING: '编制中', REVISING: '修改中', ISSUED: '已下发' } as const

/** 工艺状态。 */
export const PROCESS_STATUS_TEXT = { NONE: '无', DRAFTING: '编制中', REVISING: '修改中', ISSUED: '已下发' } as const
