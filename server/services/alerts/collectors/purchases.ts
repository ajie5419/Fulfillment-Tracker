import { prisma } from '../../../utils/prisma'
import { DELAY_REASON_TEXT, PAYMENT_STATUS_TEXT, PURCHASE_DEPT, currentDelayReason, judgeW6, w6Summary } from '../../purchases/constants'
import { alertKey, type Thresholds } from '../rules'
import type { Target } from '../types'

/**
 * W6 关键物料未到货（R10）：未到货的采购行，判定见 purchases/constants.ts judgeW6
 * （承诺到货日已过；需求日前 N 天仍无承诺日；需求日已过仍未到货直接红）。
 * 责任人：采购负责人，没指定时是采购部负责人；责任部门是采购部（黄色起通知采购部负责人、工单项目经理，红色再加项目部负责人、分管领导）。
 * 有没付的"卡交期"付款申请时，黄色起加通知财务，标题里写明，便于区分付款原因和管理原因。
 * 只看 QMS 里还在（未删除）的工单。红色不转异常。
 */
export async function collectW6(now: Date, t: Thresholds, offDays: string[]): Promise<Target[]> {
  const lines = await prisma.purchaseLine.findMany({
    where: { status: 'OPEN' },
    include: { payments: { select: { payment: { select: { status: true, blocksDelivery: true } } } } },
  })
  if (!lines.length) return []
  const [wos, roles] = await Promise.all([
    prisma.qmsWorkOrder.findMany({ where: { workOrderNumber: { in: [...new Set(lines.map((l) => l.workOrderNumber))] }, isDeleted: false }, select: { workOrderNumber: true } }),
    prisma.notifyRole.findMany({ where: { OR: [{ role: 'FINANCE' }, { role: 'DEPT_HEAD', department: PURCHASE_DEPT }] }, select: { role: true, userId: true } }),
  ])
  const live = new Set(wos.map((w) => w.workOrderNumber))
  const heads = [...new Set(roles.filter((r) => r.role === 'DEPT_HEAD').map((r) => r.userId))]
  const finance = [...new Set(roles.filter((r) => r.role === 'FINANCE').map((r) => r.userId))]
  const out: Target[] = []
  for (const l of lines) {
    if (!live.has(l.workOrderNumber)) continue
    const r = judgeW6({ needDate: l.needDate, promisedDate: l.promisedDate, now, offDays }, t.W6)
    if (!r.trigger) continue
    const blocking = l.payments.map((p) => p.payment).find((p) => p.blocksDelivery && p.status !== 'PAID')
    const reason = currentDelayReason(l.delayReason, l.payments.map(p => p.payment.status))
    const extra = [blocking ? `卡交期付款${PAYMENT_STATUS_TEXT[blocking.status]}` : '', reason ? `原因：${DELAY_REASON_TEXT[reason]}` : ''].filter(Boolean)
    out.push({
      rule: 'W6',
      refType: 'purchase',
      refId: l.id,
      key: alertKey('W6', 'purchase', l.id),
      workOrderNumber: l.workOrderNumber,
      ownerIds: l.buyerId ? [l.buyerId] : heads,
      watcherIds: blocking ? finance : [],
      deptNames: [PURCHASE_DEPT],
      startAt: r.trigger === 'OVERDUE' ? l.promisedDate! : l.needDate,
      level: r.level,
      subject: `关键物料 ${l.materialName}${l.spec ? `（${l.spec}）` : ''}`,
      summary: `${w6Summary(r, l)}${extra.length ? `；${extra.join('，')}` : ''}`,
    })
  }
  return out
}
