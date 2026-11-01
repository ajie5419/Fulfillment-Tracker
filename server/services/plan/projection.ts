/** 总计划展示投影：挂靠任务与页面 DTO。 */
import { STEP_STATUS_TEXT } from '../../../shared/flow'
import type { Alert, PlanChangeLog, QmsWorkOrder, WorkOrderExt, WorkOrderPlan } from '@prisma/client'
import { dateFieldDay } from '../alerts/rules'
import { shanghaiDay } from '../alerts/rules'
import { BUSINESS_DEPT_NAME } from '../auth/departments'
import { type RoleContext, canOperate, isDeptHead } from '../auth/permissions'
import { DRAWING_STATUS_TEXT, drawingLink } from '../drawings/constants'
import { processSummary } from '../process/constants'
import { MODE_TEXT, type NameMaps } from '../flow/names'
import { kittingLink } from '../kitting/constants'
import { PURCHASE_STATUS_TEXT, purchaseLink } from '../purchases/constants'
import { CONFIRM_TEXT, TASK_KIND_TEXT, assemblyFacts, drawingFacts, planTaskFacts, purchaseFacts, stepFacts,
  planLink, w9PlanKey, w9Key, w9ConfirmKey, w9SplitKey, outlineCodes, pushersOf, downstreamOf, isCritical } from './constants'
import type { PlanSources, unlinkedCounts } from './loaders'
import type { PlanData, TaskRow } from './types'

const day = (d: Date) => dateFieldDay(d)

export function projectPlanTasks({ drawings, purchases, steps, assemblies, others, kits, names, today }: PlanSources): TaskRow[] {
  const tasks: TaskRow[] = [
    ...drawings.map((d) => ({
      kind: 'drawing' as const,
      id: d.id,
      nodeId: d.planNodeId!,
      name: d.componentName,
      dateLabel: d.drawnDate && d.needsCustomerConfirm && !d.customerConfirmedDate && d.customerPlanDate ? '客户确认计划日' : '计划完成日',
      // 工艺模块（10-27）：设计任务后面带上料单、工艺状态，工单详情里一眼看到工艺跟上没有
      statusText: d.status === 'CANCELLED' ? DRAWING_STATUS_TEXT[d.status] : `${DRAWING_STATUS_TEXT[d.status]} · ${processSummary(d)}`,
      link: drawingLink(d.id),
      facts: drawingFacts(d),
    })),
    ...purchases.map((l) => ({
      kind: 'purchase' as const,
      id: l.id,
      nodeId: l.planNodeId!,
      name: l.spec ? `${l.materialName}（${l.spec}）` : l.materialName,
      dateLabel: l.promisedDate ? '承诺到货日' : '需求日',
      statusText: PURCHASE_STATUS_TEXT[l.status],
      link: purchaseLink(l.id),
      facts: purchaseFacts(l),
    })),
    ...steps.map((s) => ({
      kind: 'step' as const,
      id: s.id,
      nodeId: s.planNodeId!,
      name: `${s.part.name} · ${names.process.get(s.processId) ?? s.processId}（${MODE_TEXT[s.mode]}）`,
      dateLabel: s.mode === 'EXTERNAL_OUTSOURCE' && s.promisedReturnDate ? '承诺返回日' : '要求完成日',
      statusText: STEP_STATUS_TEXT[s.status],
      link: `/parts?wo=${encodeURIComponent('')}`, // 下面按节点所属工单补全
      facts: stepFacts(s, shanghaiDay),
    })),
    ...assemblies.map((a) => {
      const kit = kits.get(a.id) ?? { total: 0, ready: 0 }
      return {
        kind: 'assembly' as const,
        id: a.id,
        nodeId: a.planNodeId!,
        name: a.name,
        dateLabel: '需求日',
        statusText: kit.total ? `齐套 ${kit.ready}/${kit.total}` : '清单为空',
        link: kittingLink(a.id),
        facts: assemblyFacts(a, kit, today),
      }
    }),
    ...others.map((t) => ({
      kind: 'task' as const,
      id: t.id,
      nodeId: t.planNodeId,
      name: t.name,
      dateLabel: '计划完成日',
      statusText: t.doneDate ? '已完成' : `负责人 ${names.user.get(t.ownerId) ?? t.ownerId}`,
      link: planLink(t.workOrderNumber, t.planNodeId),
      facts: planTaskFacts(t),
      owner: { id: t.ownerId, name: names.user.get(t.ownerId) ?? t.ownerId },
      note: t.note,
    })),
  ]
  return tasks
}

interface PlanViewSources {
  wo: QmsWorkOrder
  data: PlanData
  plan: WorkOrderPlan | null
  ext: WorkOrderExt | null
  logs: PlanChangeLog[]
  unlinked: Awaited<ReturnType<typeof unlinkedCounts>>
  names: NameMaps
  mine: Set<string>
  alerts: Pick<Alert, 'activeKey' | 'level'>[]
}

export function projectPlan({ wo, data, plan, ext, logs, unlinked, names, mine, alerts }: PlanViewSources, workOrderNumber: string, ctx: RoleContext) {
  const user = (id: string | null | undefined) => (id ? (names.user.get(id) ?? id) : null)
  const levelOf = new Map(alerts.map((a) => [a.activeKey!, a.level]))
  const planAlert = alerts.find((a) => a.activeKey === w9PlanKey(workOrderNumber))
  const published = plan?.status === 'PUBLISHED'
  const est = new Map(data.forecast.nodes.map((n) => [n.id, n]))
  /** 大纲编号：阶段.节点.子节点（没用阶段时 节点.子节点），页面、前置节点、影响范围都用它 */
  const codeOf = outlineCodes(data.nodes)
  const seqName = new Map(data.nodes.map((n) => [n.id, { seq: n.seq, code: codeOf.get(n.id)!, name: n.name }]))
  /** 用了前置节点、开始日或子节点（多条线并行）：页面才显示余量 / 关键节点；一条主线时每个节点都"关键"，不显示 */
  const network = data.nodes.some((n) => n.customDeps || n.startDate || n.parentId)
  // 有后续 = 能推后别的节点（汇总行自己的前置不推任何节点，不算）
  const hasSucc = new Set(data.forecast.nodes.flatMap((e) => pushersOf(e)))
  const affects = downstreamOf(data.forecast.nodes)
  const lastId = data.forecast.lastNodeId
  return {
    workOrder: {
      workOrderNumber,
      projectName: wo.projectName,
      customerName: wo.customerName,
      deliveryDate: data.deliveryDay,
      projectManagerId: ext?.projectManagerId ?? null,
      projectManagerName: user(ext?.projectManagerId),
    },
    plan: plan ? { status: plan.status, templateName: plan.templateName, publishedAt: plan.publishedAt, publishedByName: user(plan.publishedBy) } : null,
    expectedDelivery: data.forecast.expectedDelivery,
    deliveryDelayDays: data.forecast.deliveryDelayDays,
    delayedNodes: data.forecast.delayedNodes,
    sourceNodes: data.forecast.sourceNodes,
    /** W9 工单级（预计交期晚于合同交期）的活动预警级别 */
    planAlertLevel: planAlert?.level ?? null,
    unlinked,
    network,
    /** 没有后续节点接着的节点（最后一个除外）：它们晚了不影响预计交期，多半是漏连了前置关系 */
    dangling: network ? data.nodes.filter((n) => n.id !== lastId && !hasSucc.has(n.id)).map((n) => ({ id: n.id, seq: n.seq, code: codeOf.get(n.id)!, name: n.name })) : [],
    /** 对应交期的节点（最后一个一级节点） */
    lastNodeId: lastId,
    /** 阶段下拉（已用过的阶段名，按出现顺序） */
    phases: [...new Set(data.nodes.map((n) => n.phase).filter((x): x is string => !!x))],
    canEdit: canOperate(ctx, 'plan', { workOrderNumber }),
    /** 节点"分解"菜单里能新建哪几类部门记录（只决定显示，后端各自再校验） */
    canCreate: {
      drawing: canOperate(ctx, 'drawing', { workOrderNumber }),
      purchase: canOperate(ctx, 'purchase', { workOrderNumber }),
      route: canOperate(ctx, 'route', { workOrderNumber }),
      kitting: ctx.isAdmin || isDeptHead(ctx, 'PRODUCTION') || ctx.pmOf.has(workOrderNumber),
    },
    nodes: data.nodes.map((n) => {
      const e = est.get(n.id)!
      const tasks = data.tasks.filter((t) => t.nodeId === n.id)
      const canSplit = canOperate(ctx, 'planTask', { workOrderNumber, dept: n.dept })
      return {
        id: n.id,
        seq: n.seq,
        code: codeOf.get(n.id)!,
        name: n.name,
        dept: n.dept,
        deptText: BUSINESS_DEPT_NAME[n.dept],
        note: n.note,
        /** 上级节点（子节点）；子节点数 */
        parentId: n.parentId,
        childCount: e.children.length,
        phase: n.phase,
        startDate: n.startDate ? day(n.startDate) : null,
        planDate: day(n.planDate),
        /** 前置节点：customDeps = false 时是默认的"上一个节点" */
        customDeps: n.customDeps,
        preds: e.preds.map((id) => ({ id, ...seqName.get(id)! })),
        /** 被哪个前置节点（或子节点，child = true）推后（driver = prev 时） */
        pushedBy: e.pushedBy ? { ...seqName.get(e.pushedBy)!, child: e.children.includes(e.pushedBy) } : null,
        /** 影响范围：本节点晚了会推后的节点（按页面顺序；一条主线时就是后面全部） */
        affects: (affects.get(n.id) ?? []).map((id) => seqName.get(id)!),
        slackDays: network ? e.slackDays : null,
        critical: network && isCritical(e),
        baselineDate: n.baselineDate ? day(n.baselineDate) : null,
        expectedDate: e.expectedDay,
        actualDate: e.actualDay,
        done: e.done,
        doneBy: e.doneBy,
        manualDoneByName: user(n.manualDoneBy),
        delayDays: e.delayDays,
        driver: e.driver,
        selfExpectedDate: e.selfExpectedDay,
        selfDelayDays: e.selfDelayDays,
        source: e.source,
        upstream: e.upstream,
        confirmStatus: n.confirmStatus,
        confirmText: n.confirmStatus ? CONFIRM_TEXT[n.confirmStatus] : null,
        confirmedByName: user(n.confirmedBy),
        confirmedAt: n.confirmedAt,
        rejectReason: n.rejectReason,
        taskCount: e.taskCount,
        doneCount: e.doneCount,
        overdueCount: e.overdueCount,
        lateCount: e.lateCount,
        alertLevel: levelOf.get(w9Key(n.id)) ?? null,
        confirmAlertLevel: levelOf.get(w9ConfirmKey(n.id)) ?? null,
        tasks: tasks.map((t) => {
          const te = e.tasks.find((x) => x.kind === t.kind && x.id === t.id)!
          return {
            kind: t.kind,
            kindText: TASK_KIND_TEXT[t.kind],
            id: t.id,
            name: t.name,
            dateLabel: t.dateLabel,
            planDate: t.facts.planDay,
            expectedDate: te.expectedDay,
            doneDate: t.facts.done ? t.facts.doneDay : null,
            done: t.facts.done,
            excluded: t.facts.excluded,
            overdue: te.overdue,
            lateForNode: te.lateForNode,
            statusText: t.statusText,
            link: t.link,
            ownerId: t.owner?.id ?? null,
            ownerName: t.owner?.name ?? null,
            note: t.note ?? null,
            /** 其他任务：能改 / 删（节点责任部门的人、项目经理、项目部、管理员）；能标完成 / 撤销（再加任务负责人） */
            canEdit: t.kind === 'task' && canSplit,
            canDone: t.kind === 'task' && (canSplit || t.owner?.id === ctx.userId),
          }
        }),
        /** 未分解：节点下还没有任何部门任务（不算已取消的），也没有子节点 */
        unsplit: e.taskCount === 0 && e.children.length === 0,
        splitAlertLevel: levelOf.get(w9SplitKey(n.id)) ?? null,
        /** 能在这个节点下分解（加其他任务；4 类记录另看 canCreate） */
        canSplit,
        canConfirm: published && n.confirmStatus !== null && (canOperate(ctx, 'planConfirm', { dept: n.dept }) || mine.has(n.id)),
        canComplete: canOperate(ctx, 'planNodeDone', { workOrderNumber, dept: n.dept }),
      }
    }),
    changeLogs: logs.map((l) => ({
      id: l.id,
      nodeId: l.nodeId,
      nodeName: l.nodeName,
      kind: l.kind,
      oldDate: l.oldDate ? day(l.oldDate) : null,
      newDate: l.newDate ? day(l.newDate) : null,
      reason: l.reason,
      actorName: user(l.actorId),
      createdAt: l.createdAt,
    })),
  }
}
