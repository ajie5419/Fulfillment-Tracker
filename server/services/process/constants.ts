import { MATERIAL_STATUS_TEXT as SHARED_MATERIAL_STATUS_TEXT, PROCESS_STATUS_TEXT as SHARED_PROCESS_STATUS_TEXT } from '../../../shared/process'
/**
 * 工艺模块（10-27，zhao 定）的常量与纯函数：料单 / 工艺状态的文案、允许的状态变化。不碰数据库，便于单测。
 *
 * 按部件跟踪，挂在设计任务上（一个设计任务 = 一个部件）：
 *   料单：未开始 → 编制中 → 已下发；已下发后要改先点"修改"（修改中），改完再下发。编制中可以撤回到未开始（点错了）。
 *   工艺：无 → 编制中 → 已下发；已下发后要改点"修改"回到编制中。编制中可以撤回到无。发放单作废自动转修改中，再次发放后可重新下发。
 * 设计变更涉及已下发的料单时，系统自动改成"修改中"（releases.ts createRelease → process.ts markRevisingByChange）。
 */
import type { MaterialListStatus, ProcessDocKind, ProcessDocStatus } from '@prisma/client'
import { BUSINESS_DEPT_NAME } from '../../../shared/business-depts'
import type { ProcessAction } from '../../../shared/process'
export type { ProcessAction } from '../../../shared/process'

/** 料单、工艺的负责部门：设计变更自动改"修改中"时提醒它的负责人 */
export const PROCESS_DEPT = BUSINESS_DEPT_NAME.PROCESS

export const MATERIAL_STATUS_TEXT: Record<MaterialListStatus, string> = SHARED_MATERIAL_STATUS_TEXT

export const PROCESS_STATUS_TEXT: Record<ProcessDocStatus, string> = SHARED_PROCESS_STATUS_TEXT

export const KIND_TEXT: Record<ProcessDocKind, string> = { MATERIAL: '料单', PROCESS: '工艺' }

/** 操作：开始编制 / 下发 / 修改（已下发后要改） / 撤回（编制中点错了） */
export const ACTION_TEXT: Record<ProcessAction, string> = { start: '开始编制', issue: '下发', revise: '修改', reset: '撤回' }

type AnyStatus = MaterialListStatus | ProcessDocStatus

const MATERIAL_MOVES: Record<ProcessAction, { from: MaterialListStatus[]; to: MaterialListStatus }> = {
  start: { from: ['NOT_STARTED'], to: 'DRAFTING' },
  issue: { from: ['DRAFTING', 'REVISING'], to: 'ISSUED' },
  revise: { from: ['ISSUED'], to: 'REVISING' },
  reset: { from: ['DRAFTING'], to: 'NOT_STARTED' },
}

const PROCESS_MOVES: Record<ProcessAction, { from: ProcessDocStatus[]; to: ProcessDocStatus }> = {
  start: { from: ['NONE'], to: 'DRAFTING' },
  issue: { from: ['DRAFTING', 'REVISING'], to: 'ISSUED' },
  revise: { from: ['ISSUED'], to: 'DRAFTING' },
  reset: { from: ['DRAFTING'], to: 'NONE' },
}

/** 从当前状态做这个操作后的新状态；不允许时返回 null */
export function nextStatus(kind: ProcessDocKind, current: AnyStatus, action: ProcessAction): AnyStatus | null {
  const move = (kind === 'MATERIAL' ? MATERIAL_MOVES : PROCESS_MOVES)[action] as { from: AnyStatus[]; to: AnyStatus }
  return move.from.includes(current) ? move.to : null
}

/** 当前状态下可以做的操作（按钮） */
export function allowedActions(kind: ProcessDocKind, current: AnyStatus): ProcessAction[] {
  return (['start', 'issue', 'revise', 'reset'] as const).filter((a) => nextStatus(kind, current, a) !== null)
}

export const statusText = (kind: ProcessDocKind, s: string) =>
  (kind === 'MATERIAL' ? (MATERIAL_STATUS_TEXT as Record<string, string>) : (PROCESS_STATUS_TEXT as Record<string, string>))[s] ?? s

/** 列表视图：todo = 还没做完（料单未下发，或工艺在编制中）；waiting = 图纸已发放、料单还没开始；revising = 料单修改中 */
export type ProcessView = 'todo' | 'waiting' | 'drafting' | 'revising' | 'issued' | 'all'

export const processLink = (workOrderNumber: string, view: ProcessView = 'all') => `/process?wo=${encodeURIComponent(workOrderNumber)}&view=${view}`

/** 设计任务列表、工单详情里的一句话：料单 已下发 · 工艺 编制中 */
export const processSummary = (t: { materialStatus: MaterialListStatus; processStatus: ProcessDocStatus }) =>
  `料单${MATERIAL_STATUS_TEXT[t.materialStatus]} · 工艺${PROCESS_STATUS_TEXT[t.processStatus]}`
