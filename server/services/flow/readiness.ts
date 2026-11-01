/**
 * "可以开工"的统一口径（生产管理重设计第一批，zhao 10-26 确认）。纯函数，不碰数据库。
 *
 *   第一道：工件挂了（未取消的）关键物料或设计任务时，要物料全到货、设计全完成、料单全下发；什么都没挂的直接算可以开工。
 *   其余道：上一道已完成，或上一道已有部分返回 / 报工（结构件常常先回来先转，与给下一道发待办的时机一致）。
 *
 * 工作台"可以开工"待办（purchases.refreshPartReady）、生产调度、车间看板都用这里的判断，
 * 不再出现"看板说能开工、待办里却没有"的情况。待办只在"挂了东西、且全齐了"的那一刻发（什么都没挂的工件不发，原规则不变）。
 */
import type { DrawingTaskStatus, MaterialListStatus, PurchaseStatus, StepStatus } from '@prisma/client'

/** 工件开工前提：关键物料和设计任务（已取消的不算） */
export interface PartPrereq {
  purchases: PurchaseStatus[]
  drawings: { status: DrawingTaskStatus; materialStatus: MaterialListStatus }[]
}

import type { PrereqState } from '../../../shared/flow-view'
export type { PrereqState } from '../../../shared/flow-view'

export function prereqState(p: PartPrereq): PrereqState {
  const lines = p.purchases.filter((s) => s !== 'CANCELLED')
  const drawings = p.drawings.filter((s) => s.status !== 'CANCELLED')
  return {
    tracked: lines.length + drawings.length > 0,
    missingMaterial: lines.filter((s) => s !== 'ARRIVED').length,
    missingDrawing: drawings.filter((s) => s.status !== 'DONE').length,
    missingMaterialList: drawings.filter((s) => s.materialStatus !== 'ISSUED').length,
  }
}

/** 物料、设计和料单都齐了（没挂东西也算齐） */
export const prereqMet = (s: PrereqState) => s.missingMaterial === 0 && s.missingDrawing === 0 && s.missingMaterialList === 0

/** "可以开工"待办该发的条件：挂了东西，且都齐了 */
export const prereqReadyForTodo = (s: PrereqState) => s.tracked && prereqMet(s)

export type NotReadyReason = 'PREV_NOT_DONE' | 'MATERIAL' | 'DRAWING' | 'MATERIAL_LIST' | 'HELD'

export interface ReadinessInput {
  status: StepStatus
  /** 等变更（设计变更发放后还没确认影响） */
  held: boolean
  /** 上一道；null = 这是第一道 */
  prev: { status: StepStatus; doneQty: number } | null
  /** 工件的开工前提（只对第一道有意义） */
  prereq: PrereqState
}

export interface Readiness {
  ready: boolean
  /** 不能开工的原因（只给待开工的工序）；前一道没做完是"排队中"，不算卡住 */
  reason: NotReadyReason | null
}

/** 待开工的工序现在能不能开工；不是待开工的返回 ready=false、reason=null */
export function stepReadiness(s: ReadinessInput): Readiness {
  if (s.status !== 'PENDING') return { ready: false, reason: null }
  if (s.prev) {
    const prevOk = s.prev.status === 'DONE' || s.prev.doneQty > 0
    if (!prevOk) return { ready: false, reason: 'PREV_NOT_DONE' }
  } else {
    if (s.prereq.missingMaterial > 0) return { ready: false, reason: 'MATERIAL' }
    if (s.prereq.missingDrawing > 0) return { ready: false, reason: 'DRAWING' }
    if (s.prereq.missingMaterialList > 0) return { ready: false, reason: 'MATERIAL_LIST' }
  }
  if (s.held) return { ready: false, reason: 'HELD' }
  return { ready: true, reason: null }
}

/**
 * 第一道的"可以开工"待办该不该有（生产管理重设计第二批：待办与生产调度同一条规则）：
 * 工件挂了物料 / 设计任务（没挂的不发，原规则不变），且第一道按 stepReadiness 能开工——还在待开工、物料图纸料单都齐、没在"等变更"。
 * 厂外外协的第一道同样走这条待办（页面上按方式显示"登记发出"或"开工"），缺料缺图时不发，生产调度里显示"卡住"。
 */
export function firstStepTodoReady(first: { status: StepStatus; held: boolean } | null, prereq: PrereqState): boolean {
  if (!first || !prereq.tracked) return false
  return stepReadiness({ status: first.status, held: first.held, prev: null, prereq }).ready
}

/** 卡住原因的文字（生产调度"卡住"、工件抽屉用） */
export function stuckText(reason: 'BLOCKED' | Exclude<NotReadyReason, 'PREV_NOT_DONE'>, prereq?: PrereqState): string {
  switch (reason) {
    case 'BLOCKED':
      return 'QMS 判不合格，等异常处理'
    case 'HELD':
      return '设计变更还没确认影响（等变更）'
    case 'MATERIAL':
      return `缺料：还有 ${prereq?.missingMaterial ?? 0} 项关键物料没到货`
    case 'MATERIAL_LIST':
      return '料单未下发'
    case 'DRAWING':
      return `缺图：还有 ${prereq?.missingDrawing ?? 0} 个设计任务没完成`
  }
}
