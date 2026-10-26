/**
 * 完工（自制、厂内外协），含部分完工和报废。单独成文件：报废要生成异常，异常模块又依赖 flow.ts，放在这里避免循环引用。
 */
import { createScrapIssue } from '../issues/scrap'
import { issueTransaction } from '../issues/issues'
import { FlowError } from './errors'
import { type ActInput, type ReturnResult, applyReturn, assertInPlant, lockStep, returnedQty } from './flow'

/** 完工时数量不够：剩下的还在做（含返修）/ 报废了 */
export type FinishRest = 'CONTINUE' | 'SCRAP'

export interface FinishInput extends ActInput {
  /** 本次完成的数量；不填 = 剩余全部 */
  qty?: number
  /** 本次数量少于剩余数量时必填 */
  rest?: FinishRest
  /** 报废原因 */
  note?: string | null
}

export interface FinishResult extends ReturnResult {
  /** 报废时自动生成的异常编号 */
  issueNo: string | null
}

/**
 * 完工：自制、厂内外协。没点开工直接完工也允许（开工是可选的）。
 * - 不填数量或数量 = 剩余：全部完工，步骤完成（与原来一致）。
 * - 数量少于剩余、剩下的还在做：记"部分完工"（REPORT），计入已完成数量，步骤继续加工；第一次报工就给下一道发待办。
 * - 数量少于剩余、剩下的报废：完成的记 FINISH，报废的记 SCRAP（不计入已完成数量），步骤完成；
 *   同时生成一条"车间"异常（来源：报废），默认给生产部负责人安排补料重做。
 */
export function finishStep(input: FinishInput): Promise<FinishResult> {
  return issueTransaction(async (tx) => {
    const step = await lockStep(tx, input.stepId)
    assertInPlant(step)
    if (step.status !== 'PENDING' && step.status !== 'IN_PROGRESS') throw new FlowError('该步骤已完成')
    const remaining = Math.max(step.part.quantity - (await returnedQty(tx, step.id)), 0)
    const qty = input.qty ?? remaining
    if (qty < 0) throw new FlowError('完成数量不能为负数')
    if (qty > remaining) throw new FlowError(`完成数量超过剩余数量（还剩 ${remaining} 件）`)
    const now = new Date()
    const base = { source: input.source, actorId: input.actorId, occurredAt: now }
    if (qty === remaining) return { ...(await applyReturn(tx, step, { ...base, type: 'FINISH', qty, forceDone: true })), issueNo: null }
    if (!input.rest) throw new FlowError(`还差 ${remaining - qty} 件：请选择剩下的是还在做，还是报废了`)
    if (input.rest === 'CONTINUE') {
      if (qty === 0) throw new FlowError('部分完工的数量至少 1 件')
      return { ...(await applyReturn(tx, step, { ...base, type: 'REPORT', qty, forceDone: false })), issueNo: null }
    }
    // 报废：先记报废事件（不计数量），再按完工收尾
    const scrapQty = remaining - qty
    const note = input.note?.trim() || null
    const scrap = await tx.flowEvent.create({ data: { stepId: step.id, type: 'SCRAP', qty: scrapQty, note, ...base } })
    const result = await applyReturn(tx, step, { ...base, type: 'FINISH', qty, forceDone: true })
    const issue = await createScrapIssue(tx, step, { eventId: scrap.id, scrapQty, doneQty: qty, note, actorId: input.actorId })
    return { ...result, issueNo: issue.issueNo }
  })
}
