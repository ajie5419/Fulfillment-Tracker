import { prisma } from '../../utils/prisma'
import { ISSUE_NUMBER_CONFLICT_RETRIES, formatIssueNo, issueNoPrefix, nextSeq } from './constants'
import type { Tx } from './types'

const uniqueOn = (err: unknown, field: string) => {
  const e = err as { code?: string; meta?: { target?: unknown } }
  return e?.code === 'P2002' && String(e.meta?.target ?? '').includes(field)
}

/** 系统来源的异常撞上 sourceKey 唯一键：别处（并发的另一轮扫描）已经生成过 */
export const isSourceKeyConflict = (err: unknown) => uniqueOn(err, 'sourceKey')

/** 带编号冲突重试的事务：两个请求同时取到同一个当天序号时，后提交的撞唯一键，整个事务重来 */
export async function issueTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(fn)
    } catch (err) {
      if (attempt < ISSUE_NUMBER_CONFLICT_RETRIES && uniqueOn(err, 'issueNo')) continue
      throw err
    }
  }
}

export async function nextIssueNo(tx: Tx, now: Date) {
  const prefix = issueNoPrefix(now)
  const last = await tx.issue.findFirst({ where: { issueNo: { startsWith: prefix } }, orderBy: { issueNo: 'desc' }, select: { issueNo: true } })
  return formatIssueNo(prefix, nextSeq(prefix, last?.issueNo ?? null))
}
