export type ProcessKind = 'MATERIAL' | 'PROCESS'
export type ProcessAction = 'start' | 'issue' | 'revise' | 'reset'

/** 只有向前编制、下发需要有效发放单；修改、撤回始终允许回退。前后端共用文案。 */
export function processReleaseBlockReason(kind: ProcessKind, action: ProcessAction, released: boolean): string | null {
  if (released || (action !== 'start' && action !== 'issue')) return null
  return `图纸未发放，不能${action === 'start' ? '开始编制' : '下发'}${kind === 'MATERIAL' ? '料单' : '工艺'}`
}
