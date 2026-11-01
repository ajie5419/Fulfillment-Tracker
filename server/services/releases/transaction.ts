import type { Prisma } from '@prisma/client'
import { isDeadlock, prisma } from '../../utils/prisma'
import { formatIssueNo, nextSeq } from '../issues/constants'
import { releaseNoPrefix } from './constants'

type Tx = Prisma.TransactionClient

/**
 * 重试：①编号冲突——两个请求同时取到同一个当天序号时，后提交的撞唯一键；②死锁（P2034，或 FOR UPDATE 里的 P2010/1213）——两张设计变更同时发、
 * 各自先锁了一个设计任务、再去锁对方的（工艺模块：料单改"修改中"），数据库回滚其中一个。整个事务重来，事务里只有数据库写入，重来不会重复发通知。
 */
export async function releaseTransaction<T>(fn: (tx: Tx) => Promise<T>, readCommitted = false): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(fn, readCommitted ? { isolationLevel: 'ReadCommitted' } : undefined)
    } catch (err) {
      const e = err as { code?: string; meta?: { target?: unknown } }
      const retryable = isDeadlock(err) || (e?.code === 'P2002' && String(e.meta?.target ?? '').includes('releaseNo'))
      if (attempt < 5 && retryable) continue
      throw err
    }
  }
}

export async function nextReleaseNo(tx: Tx, now: Date) {
  const prefix = releaseNoPrefix(now)
  const last = await tx.release.findFirst({ where: { releaseNo: { startsWith: prefix } }, orderBy: { releaseNo: 'desc' }, select: { releaseNo: true } })
  return formatIssueNo(prefix, nextSeq(prefix, last?.releaseNo ?? null))
}
