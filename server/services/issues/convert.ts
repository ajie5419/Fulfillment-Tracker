/**
 * 预警转异常（方案 5.2、6.2）：红色预警由扫描任务自动转，黄色预警由责任人、项目经理、管理员手动转，共用这里。
 *
 * 分类：W1 → 外协-进度；W2 → 停滞的这道是外协（厂内/厂外）则外协-进度，自制则车间；W3 → 外协-进度（带外协单位）。
 * 责任人 = 预警责任人（第一个），没有则用分类默认部门的负责人。W4 本身就是异常超期，不转。
 * 转完预警状态改为"已转异常"（CONVERTED），activeKey 保留：同一对象不会立刻再生成新预警，也不再升级、不再通知；
 * 对象状态变化（原本会消除预警的时机）时只把 activeKey 置空，状态保持 CONVERTED，异常不随之关闭。
 */
import type { Alert, IssueCategory, Prisma, StepMode } from '@prisma/client'
import { FlowError } from '../flow/errors'
import { createSystemIssue } from './issues'
import type { IssueRefType } from './constants'

type Tx = Prisma.TransactionClient

export const alertSourceKey = (alertId: string) => `ALERT:${alertId}`

/** 转异常需要的预警对象信息（扫描任务的 Target 的子集） */
export interface ConvertTarget {
  rule: 'W1' | 'W2' | 'W3' | 'W4'
  refType: string
  refId: string
  workOrderNumber: string | null
  ownerIds: string[]
  subject: string
  summary: string
  meta?: { stepMode?: StepMode; supplierId?: string | null }
}

const RULE_NAME = { W1: 'W1 待确认匹配超时', W2: 'W2 转序停滞', W3: 'W3 外协逾期未返', W4: 'W4 异常超期' } as const
const LEVEL_NAME = { REMIND: '提醒', YELLOW: '黄色', RED: '红色' } as const

export function categoryFor(target: ConvertTarget): { category: IssueCategory; supplierId: string | null } {
  if (target.rule === 'W2') {
    return target.meta?.stepMode && target.meta.stepMode !== 'SELF'
      ? { category: 'OUTSOURCE_SCHEDULE', supplierId: target.meta.supplierId ?? null }
      : { category: 'WORKSHOP', supplierId: null }
  }
  return { category: 'OUTSOURCE_SCHEDULE', supplierId: target.rule === 'W3' ? (target.meta?.supplierId ?? null) : null }
}

const REF_TYPE: Record<string, IssueRefType> = { step: 'STEP', unmatched: 'UNMATCHED' }

/**
 * 在调用方事务里把预警转成异常并标记 CONVERTED。调用方负责先锁住预警行并确认它还是活动的。
 * 已有同一预警生成的异常时（sourceKey 已存在）直接复用，只补标记。
 */
export async function convertAlertInTx(tx: Tx, alert: Alert, target: ConvertTarget, actorId: string | null) {
  if (target.rule === 'W4') throw new FlowError('异常超期预警不能再转异常')
  if (!target.workOrderNumber) throw new FlowError('预警没有关联工单，不能转异常')
  const sourceKey = alertSourceKey(alert.id)
  let issue = await tx.issue.findUnique({ where: { sourceKey } })
  if (!issue) {
    const { category, supplierId } = categoryFor(target)
    const how = actorId ? '手动转为异常' : '自动转为异常'
    issue = await createSystemIssue(tx, {
      sourceKey,
      source: 'ALERT',
      category,
      workOrderNumber: target.workOrderNumber,
      refType: REF_TYPE[target.refType] ?? 'STEP',
      refId: target.refId,
      responsibleUserId: target.ownerIds[0] ?? null,
      responsibleSupplierId: supplierId,
      // 手动转的由点"转异常"的人确认关闭；自动转的没有上报人
      reporterId: actorId,
      actorId,
      description: `${target.subject}：${target.summary}`,
      note: `${RULE_NAME[target.rule]}${LEVEL_NAME[alert.level]}预警${how}`,
    })
  }
  await tx.alert.update({ where: { id: alert.id }, data: { status: 'CONVERTED' } })
  return issue
}
