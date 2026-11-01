/** 状态监控的分布、下钻和预警共用的状态名称与红黄绿语义。 */
export const MONITORING_STEP_STATUSES = ['PENDING', 'OUT', 'IN_PROGRESS', 'BLOCKED'] as const
export const MONITORING_PART_STATUSES = ['ACTIVE'] as const
export const MONITORING_STATUS_TEXT = {
  PENDING: '待开工', OUT: '在外加工', IN_PROGRESS: '加工中', BLOCKED: '有异常', ACTIVE: '在制',
} as const
export type MonitoringStatus = keyof typeof MONITORING_STATUS_TEXT
export type MonitoringEntityType = 'step' | 'part'
export type MonitoringLevel = 'GREEN' | 'YELLOW' | 'RED'
export const MONITORING_LEVEL_TEXT = { GREEN: '正常', YELLOW: '关注', RED: '停滞' } as const
export const MONITORING_TONE = { GREEN: 'done', YELLOW: 'risk', RED: 'late' } as const
export const MONITORING_ENTITY_TEXT = { step: '工序', part: '工件' } as const

export const monitoringListLink = (entityType: MonitoringEntityType, status: MonitoringStatus) =>
  `/monitoring?entityType=${entityType}&status=${status}`

/** 工序编排的工件详情包含完整工序链，排队中的工序也能定位；不依赖生产调度的“可开工”范围。 */
export function monitoringDetailLink(workOrderNumber: string, partId: string, stepId?: string) {
  const q = new URLSearchParams({ wo: workOrderNumber, part: partId })
  if (stepId) q.set('step', stepId)
  return `/parts?${q}`
}

export type StatusSinceSource = 'statusSince' | 'flowEvent' | 'startedAt' | 'createdAt'

export interface MonitoredEntity {
  entityType: MonitoringEntityType
  id: string
  partId: string
  name: string
  drawingNo: string | null
  workOrderNumber: string
  status: MonitoringStatus
  statusText: string
  since: Date
  sinceSource: StatusSinceSource
  days: number
  level: MonitoringLevel
  ownerIds: string[]
  owners: { id: string; name: string | null }[]
  deptNames: string[]
  link: string
}
