import { prisma } from '../../../utils/prisma'
import { ARRANGE_SEND, ARRANGE_START } from '../../flow/flow'
import { resolveStepResponsibles } from '../../flow/responsible'
import { loadNames } from '../../flow/names'
import { PRODUCTION_DEPT } from '../../releases/constants'
import { alertKey, type Thresholds, dateFieldDay, durationText, elapsedExcludingOffDays, judgeW3, judgeW10, levelByElapsed } from '../rules'
import type { Target } from '../types'

/** W1：待确认匹配，责任人是全部外协专员 */
export async function collectW1(now: Date, t: Thresholds, offDays: string[]): Promise<Target[]> {
  const rows = await prisma.unmatchedInspection.findMany({ where: { status: 'PENDING' } })
  if (!rows.length) return []
  const [inspections, coordinators] = await Promise.all([
    prisma.qmsInspection.findMany({ where: { id: { in: rows.map((r) => r.qmsInspectionId) } } }),
    prisma.notifyRole.findMany({ where: { role: 'OUTSOURCE_COORDINATOR' }, select: { userId: true } }),
  ])
  const byId = new Map(inspections.map((i) => [i.id, i]))
  const owners = [...new Set(coordinators.map((c) => c.userId))]
  return rows.map((r) => {
    const ins = byId.get(r.qmsInspectionId)
    const elapsed = elapsedExcludingOffDays(r.createdAt, now, offDays)
    const what = [ins?.partName, ins?.processName].filter(Boolean).join(' · ') || r.qmsInspectionId
    return {
      rule: 'W1',
      refType: 'unmatched',
      refId: r.qmsInspectionId,
      key: alertKey('W1', 'unmatched', r.qmsInspectionId),
      workOrderNumber: ins?.workOrderNumber ?? null,
      ownerIds: owners,
      startAt: r.createdAt,
      level: levelByElapsed(elapsed, t.W1),
      subject: `待确认匹配 ${what}`,
      summary: `返厂报检 ${durationText(elapsed)}未确认关联`,
      meta: { supplierId: ins?.supplierId ?? null },
    }
  })
}

/**
 * W2：待开工且有"安排发出/开工"待办的步骤，从最早一条待办起计时（转交不重新计时），责任人是当前待办负责人。
 * 上一道"有异常"（QMS 不合格，已经有异常在跟）时不计时、不预警，避免与异常重复报警；
 * 上一道的异常关闭后从关闭时刻重新计时（取 待办生成 与 上一道最近一次异常关闭 中较晚的）。
 * 标了"等变更"（R9 设计变更发放时还没开工）的步骤不计时；解除后从解除时刻重新计时。
 */
export async function collectW2(now: Date, t: Thresholds, offDays: string[]): Promise<Target[]> {
  const actions = [ARRANGE_SEND, ARRANGE_START]
  const open = await prisma.todo.findMany({ where: { refType: 'step', action: { in: actions }, status: 'OPEN' } })
  if (!open.length) return []
  const stepIds = [...new Set(open.map((o) => o.refId))]
  const [steps, transferred] = await Promise.all([
    prisma.routeStep.findMany({ where: { id: { in: stepIds }, status: 'PENDING', holdReleaseId: null }, include: { part: true } }),
    prisma.todo.findMany({ where: { refType: 'step', refId: { in: stepIds }, action: { in: actions }, status: 'TRANSFERRED' }, select: { refId: true, createdAt: true } }),
  ])
  if (!steps.length) return []
  const prevSteps = await prisma.routeStep.findMany({
    where: { OR: steps.map((s) => ({ partId: s.partId, seq: { lt: s.seq } })) },
    orderBy: { seq: 'desc' },
  })
  const prevOf = (s: (typeof steps)[number]) => prevSteps.find((p) => p.partId === s.partId && p.seq < s.seq)
  const prevIds = [...new Set(steps.map((s) => prevOf(s)?.id).filter((x): x is string => !!x))]
  const [names, closes] = await Promise.all([
    loadNames({ process: [...steps, ...prevSteps].map((s) => s.processId) }),
    prevIds.length
      ? prisma.issueLog.findMany({
          where: { toStatus: 'CLOSED', issue: { refType: 'STEP', refId: { in: prevIds } } },
          select: { createdAt: true, issue: { select: { refId: true } } },
        })
      : [],
  ])
  const lastClose = new Map<string, number>()
  for (const c of closes) lastClose.set(c.issue.refId!, Math.max(lastClose.get(c.issue.refId!) ?? 0, +c.createdAt))

  const out: Target[] = []
  for (const s of steps) {
    const prev = prevOf(s)
    if (prev?.status === 'BLOCKED') continue
    const mine = open.filter((o) => o.refId === s.id)
    const todoStart = Math.min(...[...mine, ...transferred.filter((x) => x.refId === s.id)].map((x) => +x.createdAt))
    const startAt = new Date(Math.max(todoStart, (prev && lastClose.get(prev.id)) || 0, s.holdClearedAt ? +s.holdClearedAt : 0))
    const elapsed = elapsedExcludingOffDays(startAt, now, offDays)
    const verb = s.mode === 'EXTERNAL_OUTSOURCE' ? '发出' : '开工'
    out.push({
      rule: 'W2',
      refType: 'step',
      refId: s.id,
      key: alertKey('W2', 'step', s.id),
      workOrderNumber: s.part.workOrderNumber,
      ownerIds: [...new Set(mine.map((o) => o.ownerId))],
      startAt,
      level: levelByElapsed(elapsed, t.W2),
      subject: `${s.part.name} · ${names.process.get(s.processId) ?? s.processId}`,
      summary: `${prev ? `${names.process.get(prev.processId) ?? prev.processId}返厂` : '待安排'} ${durationText(elapsed)}仍未${verb}`,
      meta: { stepMode: s.mode, supplierId: s.supplierId },
    })
  }
  return out
}

/** W3：在外加工且有承诺返回日的步骤，责任人是步骤负责人（flow/responsible.ts；厂外外协没有班组长）。标了"等变更"的不计（变更影响确认后恢复） */
export async function collectW3(now: Date, t: Thresholds, offDays: string[]): Promise<Target[]> {
  const steps = await prisma.routeStep.findMany({ where: { status: 'OUT', promisedReturnDate: { not: null }, holdReleaseId: null }, include: { part: true } })
  if (!steps.length) return []
  const [names, owners] = await Promise.all([
    loadNames({ process: steps.map((s) => s.processId), supplier: steps.map((s) => s.supplierId) }),
    resolveStepResponsibles(prisma, steps.map((s) => ({ ...s, workOrderNumber: s.part.workOrderNumber }))),
  ])
  return steps.map((s, i) => {
    const r = judgeW3({ promisedReturnDate: s.promisedReturnDate!, dueDate: s.dueDate, now, offDays }, t.W3)
    const supplier = s.supplierId ? (names.supplier.get(s.supplierId) ?? s.supplierId) : '外协厂'
    const summary = r.dueDatePassed
      ? `已过要求完成日 ${dateFieldDay(s.dueDate!)}，${supplier}仍未返回`
      : r.overdueDays > 0
        ? `${supplier}超承诺返回日 ${r.overdueDays} 天未返`
        : r.daysLeft > 0
          ? `${supplier}承诺 ${dateFieldDay(s.promisedReturnDate!)} 返回，还剩 ${r.daysLeft} 天`
          : `${supplier}承诺今天返回`
    return {
      rule: 'W3',
      refType: 'step',
      refId: s.id,
      key: alertKey('W3', 'step', s.id),
      workOrderNumber: s.part.workOrderNumber,
      ownerIds: owners[i] ? [owners[i]!] : [],
      startAt: s.promisedReturnDate!,
      level: r.level,
      subject: `${s.part.name} · ${names.process.get(s.processId) ?? s.processId}`,
      summary,
      meta: { stepMode: s.mode, supplierId: s.supplierId },
    }
  })
}

/**
 * W10 厂内工序逾期未完：自制 / 厂内外协已开工（加工中）、有要求完成日的工序，责任人是工序负责人（没有时自制的班组长），黄色起通知生产经理（生产部负责人）。
 * 之前 W2 只管"还没开工"、W3 只管厂外外协，开了工的厂内工序超期没人管（10-26 借鉴 ERPNext 评估时发现）。
 * "有异常"（QMS 不合格）的工序状态是 BLOCKED，不在这里，由异常跟进；完工后自动消除。
 */
export async function collectW10(now: Date, t: Thresholds, offDays: string[]): Promise<Target[]> {
  const steps = await prisma.routeStep.findMany({
    where: { status: 'IN_PROGRESS', mode: { in: ['SELF', 'IN_PLANT_OUTSOURCE'] }, dueDate: { not: null } },
    include: { part: true },
  })
  if (!steps.length) return []
  // 责任人：工序负责人，没有时是自制工序派到的班组的班组长（flow/responsible.ts）
  const [names, owners] = await Promise.all([
    loadNames({ process: steps.map((s) => s.processId), supplier: steps.map((s) => s.supplierId) }),
    resolveStepResponsibles(prisma, steps.map((s) => ({ ...s, workOrderNumber: s.part.workOrderNumber }))),
  ])
  return steps.map((s, i) => {
    const r = judgeW10({ dueDate: s.dueDate!, now, offDays }, t.W10)
    const due = dateFieldDay(s.dueDate!)
    // 厂内外协的班组、自制派工的班组都写上
    const who = s.supplierId ? `${names.supplier.get(s.supplierId) ?? s.supplierId}` : ''
    const summary =
      r.overdueDays > 0
        ? `${who}超要求完成日 ${due} ${r.overdueDays} 天仍未完工`
        : r.daysLeft > 0
          ? `${who}要求 ${due} 完工，还剩 ${r.daysLeft} 天`
          : r.daysLeft === 0
            ? `${who}要求今天完工`
            : `${who}已过要求完成日 ${due}（中间是停工日，不计超期）`
    return {
      rule: 'W10',
      refType: 'step',
      refId: s.id,
      key: alertKey('W10', 'step', s.id),
      workOrderNumber: s.part.workOrderNumber,
      ownerIds: owners[i] ? [owners[i]!] : [],
      deptNames: [PRODUCTION_DEPT],
      startAt: s.dueDate!,
      level: r.level,
      subject: `${s.part.name} · ${names.process.get(s.processId) ?? s.processId}`,
      summary,
      meta: { stepMode: s.mode, supplierId: s.supplierId },
    }
  })
}
