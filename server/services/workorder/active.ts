/**
 * "在做的工单"口径（zhao 10-22 定：已完工 / 已取消默认隐藏，可开关查看）：QMS 里没删除、也没关闭（已完工 / 已取消）的工单。
 * 同步照常全部保存；列表、项目总览、进度类预警用这里的条件，保证各处口径一致。状态判断见 shared/status.ts CLOSED_WO_STATUSES。
 */
import type { Prisma } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { CLOSED_WO_STATUSES } from '../../../shared/status'

/** 没删除、没关闭的工单 */
export const ACTIVE_WO_WHERE = { isDeleted: false, status: { notIn: [...CLOSED_WO_STATUSES] } } satisfies Prisma.QmsWorkOrderWhereInput

/** 给定工单号里，已关闭（已完工 / 已取消）的那些 */
export async function closedWorkOrders(workOrderNumbers: string[]): Promise<Set<string>> {
  if (!workOrderNumbers.length) return new Set()
  const rows = await prisma.qmsWorkOrder.findMany({
    where: { workOrderNumber: { in: [...new Set(workOrderNumbers)] }, status: { in: [...CLOSED_WO_STATUSES] } },
    select: { workOrderNumber: true },
  })
  return new Set(rows.map((r) => r.workOrderNumber))
}
