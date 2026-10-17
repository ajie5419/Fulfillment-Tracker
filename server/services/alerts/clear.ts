/**
 * 业务对象状态变化时消除预警（方案 6.1"预警自动消除"）。发出、返厂、关联、异常关闭等业务事务调用。
 *
 *   活动预警（ACTIVE）→ 已消除（CLEARED），activeKey 置空；
 *   已转异常（CONVERTED）的预警状态保持不变，只把 activeKey 置空：异常不随之关闭，
 *   但同一对象以后再进入规则关注状态时可以重新生成预警。
 */
import type { Prisma } from '@prisma/client'

type Db = Pick<Prisma.TransactionClient, 'alert'>

export async function clearAlertKeys(db: Db, keys: string[]) {
  if (!keys.length) return 0
  const cleared = await db.alert.updateMany({ where: { activeKey: { in: keys }, status: 'ACTIVE' }, data: { status: 'CLEARED', activeKey: null } })
  await db.alert.updateMany({ where: { activeKey: { in: keys }, status: 'CONVERTED' }, data: { activeKey: null } })
  return cleared.count
}
