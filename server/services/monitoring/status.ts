import type { MonitoredEntity, StatusSinceSource } from '../../../shared/monitoring'
import type { MonitoringEntityType, MonitoringStatus, MonitoringLevel } from '../../../shared/monitoring'
import { MONITORING_STEP_STATUSES, MONITORING_PART_STATUSES, MONITORING_STATUS_TEXT, monitoringDetailLink, monitoringListLink } from '../../../shared/monitoring'
import { prisma } from '../../utils/prisma'
import { loadThresholds } from '../alerts/config'
import type { RuleThreshold } from '../alerts/rules'
import { userDeptNames } from '../auth/departments'
import { loadNames } from '../flow/names'
import { resolveStepResponsibles } from '../flow/responsible'
import { ACTIVE_WO_WHERE } from '../workorder/active'
import { partStatusSince, residenceDays, stagnationLevel, stepStatusSince } from './rules'

export type { MonitoredEntity } from '../../../shared/monitoring'

/** 总览、下钻清单、W11 扫描唯一数据口径；只算仍在履约的工单下的非终态对象。 */
export async function loadMonitoredEntities(now: Date, threshold: RuleThreshold, visibleWorkOrders?: string[]): Promise<MonitoredEntity[]> {
  const workOrders = await prisma.qmsWorkOrder.findMany({ where: { ...ACTIVE_WO_WHERE, ...(visibleWorkOrders ? { workOrderNumber: { in: visibleWorkOrders } } : {}) }, select: { workOrderNumber: true } })
  if (!workOrders.length) return []
  // 现有模型：Part 终态只有 DONE，RouteStep 终态只有 DONE；取消在工单层排除。
  const parts = await prisma.part.findMany({
    where: { status: { not: 'DONE' }, workOrderNumber: { in: workOrders.map((w) => w.workOrderNumber) } },
    include: { steps: { where: { status: { not: 'DONE' } }, orderBy: { seq: 'asc' } } },
    orderBy: { id: 'asc' },
  })
  const steps = parts.flatMap((p) => p.steps.map((s) => ({ ...s, workOrderNumber: p.workOrderNumber })))
  const [events, responsibles] = await Promise.all([
    // 聚合只取每道工序最近的 occurredAt，避免逐工序查询、也不加载全量流转历史。
    steps.length ? prisma.flowEvent.groupBy({ by: ['stepId'], where: { stepId: { in: steps.map((s) => s.id) } }, _max: { occurredAt: true } }) : [],
    resolveStepResponsibles(prisma, steps),
  ])
  const eventAt = new Map(events.map((e) => [e.stepId, e._max.occurredAt]))
  const ownerOf = new Map(steps.map((s, i) => [s.id, responsibles[i] ?? null]))
  const [names, depts] = await Promise.all([
    loadNames({ process: steps.map((s) => s.processId), user: responsibles }),
    userDeptNames(responsibles),
  ])
  const out: MonitoredEntity[] = []
  for (const part of parts) {
    const add = (entityType: MonitoringEntityType, id: string, name: string, status: MonitoringStatus, clock: { since: Date; source: StatusSinceSource }, ownerId: string | null) => {
      const days = residenceDays(clock.since, now)
      out.push({
        entityType, id, partId: part.id, name, drawingNo: part.drawingNo, workOrderNumber: part.workOrderNumber,
        status, statusText: MONITORING_STATUS_TEXT[status], since: clock.since, sinceSource: clock.source,
        days, level: stagnationLevel(days, threshold), ownerIds: ownerId ? [ownerId] : [],
        owners: ownerId ? [{ id: ownerId, name: names.user.get(ownerId) ?? null }] : [],
        deptNames: ownerId && depts.has(ownerId) ? [depts.get(ownerId)!] : [],
        link: monitoringDetailLink(part.workOrderNumber, part.id, entityType === 'step' ? id : undefined),
      })
    }
    // 工件没有独立负责人字段：只取 currentStepId 指向的在制工序责任人；缺失时留空，不把项目经理当责任人。
    add('part', part.id, part.name, 'ACTIVE', partStatusSince(part), part.currentStepId ? ownerOf.get(part.currentStepId) ?? null : null)
    for (const step of part.steps) {
      const name = `${part.name} · ${names.process.get(step.processId) ?? step.processId}（第 ${step.seq} 道）`
      add('step', step.id, name, step.status as MonitoringStatus, stepStatusSince({ ...step, latestEventAt: eventAt.get(step.id) ?? null }), ownerOf.get(step.id) ?? null)
    }
  }
  return out.sort((a, b) => b.days - a.days || +a.since - +b.since || a.entityType.localeCompare(b.entityType) || a.id.localeCompare(b.id))
}

export function monitoringSummary(entities: MonitoredEntity[]) {
  const distribution = (entityType: MonitoringEntityType, statuses: readonly MonitoringStatus[]) => statuses.map((status) => ({
    status, label: MONITORING_STATUS_TEXT[status], count: entities.filter((e) => e.entityType === entityType && e.status === status).length,
    link: monitoringListLink(entityType, status),
  }))
  return {
    steps: distribution('step', MONITORING_STEP_STATUSES),
    parts: distribution('part', MONITORING_PART_STATUSES),
    // 从完整在制集合单独计数，不取 Top 长度，也不把黄线 / 正常混入。
    redCount: entities.reduce((count, e) => count + Number(e.level === 'RED'), 0),
    top: entities.filter((e) => e.level !== 'GREEN').slice(0, 10),
  }
}

export async function getStatusMonitoring(now = new Date()) {
  const threshold = (await loadThresholds()).W11
  return { asOf: now, threshold, ...monitoringSummary(await loadMonitoredEntities(now, threshold)) }
}

export interface MonitoringFilter {
  entityType?: MonitoringEntityType
  status?: MonitoringStatus
  level?: MonitoringLevel
  page: number
  pageSize: number
}

export async function listMonitoredEntities(filter: MonitoringFilter, now = new Date()) {
  const threshold = (await loadThresholds()).W11
  const rows = (await loadMonitoredEntities(now, threshold)).filter((e) => (!filter.entityType || e.entityType === filter.entityType) && (!filter.status || e.status === filter.status) && (!filter.level || e.level === filter.level))
  const start = (filter.page - 1) * filter.pageSize
  return { asOf: now, threshold, total: rows.length, rows: rows.slice(start, start + filter.pageSize) }
}
