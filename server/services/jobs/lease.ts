/**
 * 后台任务防重叠的租约锁（job_lock 表）：lockedUntil 已过期才能抢到（条件更新，天然互斥）；
 * 进程崩溃后租约到期自动失效，不依赖数据库连接。用真实时间，不用注入的 now。
 */
import { randomUUID } from 'node:crypto'
import { prisma } from '../../utils/prisma'

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

/** 拿到租约就执行 fn，执行完释放；拿不到（另一轮还在跑）返回 { skipped: true } */
export async function withLease<T>(name: string, leaseMs: number, fn: () => Promise<T>): Promise<{ skipped: true } | { skipped: false; value: T }> {
  const holder = randomUUID()
  if (!(await acquireLease(name, holder, leaseMs))) return { skipped: true }
  try {
    return { skipped: false, value: await fn() }
  } finally {
    await releaseLease(name, holder)
  }
}
