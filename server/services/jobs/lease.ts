/**
 * 后台任务防重叠的租约锁（job_lock 表）：lockedUntil 已过期才能抢到（条件更新，天然互斥）；
 * 进程崩溃后租约到期自动失效，不依赖数据库连接。用真实时间，不用注入的 now。
 */
import { randomUUID } from 'node:crypto'
import type { JobLock, Prisma } from '@prisma/client'
import { prisma } from '../../utils/prisma'

export class LeaseLostError extends Error {
  constructor(name: string) {
    super(`Job lease lost: ${name}`)
    this.name = 'LeaseLostError'
  }
}

/** Call first inside every protected write transaction, before taking any business-row locks. */
export type LeaseGuard = (tx: Prisma.TransactionClient) => Promise<void>

export async function acquireLease(name: string, holder: string, leaseMs: number): Promise<boolean> {
  const real = new Date()
  await prisma.jobLock.createMany({ data: [{ name, lockedUntil: new Date(0) }], skipDuplicates: true })
  const r = await prisma.jobLock.updateMany({
    where: { name, lockedUntil: { lt: real } },
    data: { lockedUntil: new Date(real.getTime() + leaseMs), holder },
  })
  return r.count === 1
}

export async function releaseLease(name: string, holder: string) {
  await prisma.jobLock.updateMany({ where: { name, holder }, data: { lockedUntil: new Date(), holder: null } })
}

/**
 * The optional callback argument fences writes and renews at transaction boundaries; it uses no background timer.
 * Locking the lease row in the business transaction prevents takeover until that transaction commits or rolls back.
 * Callers that ignore the guard retain the original fixed-duration lease behavior.
 */
export async function withLease<T>(name: string, leaseMs: number, fn: (guard: LeaseGuard) => Promise<T>): Promise<{ skipped: true } | { skipped: false; value: T }> {
  const holder = randomUUID()
  if (!(await acquireLease(name, holder, leaseMs))) return { skipped: true }
  const guard: LeaseGuard = async (tx) => {
    const [lock] = await tx.$queryRaw<JobLock[]>`SELECT name, holder, lockedUntil FROM job_lock WHERE name = ${name} FOR UPDATE`
    // Read the clock after waiting for the row lock so a delayed renewal cannot revive an expired lease.
    const real = new Date()
    if (!lock || lock.holder !== holder || lock.lockedUntil <= real) throw new LeaseLostError(name)
    await tx.jobLock.updateMany({
      where: { name, holder },
      data: { lockedUntil: new Date(real.getTime() + leaseMs) },
    })
  }
  try {
    return { skipped: false, value: await fn(guard) }
  } finally {
    await releaseLease(name, holder)
  }
}
