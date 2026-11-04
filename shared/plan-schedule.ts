export interface PlanDateConflict {
  code: 'FS_ORDER' | 'MISSING_START' | 'DATE_ORDER' | 'CYCLE' | 'ACTUAL_ORDER'
  nodeId: string
  nodeName: string
  predecessorId?: string
  startDay?: string | null
  predecessorDay?: string
  message: string
  blocksPublish: boolean
}

export const PLAN_DATE_REVIEW = '日期冲突 / 待核实'
