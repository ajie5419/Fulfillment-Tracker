import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

/**
 * 事务默认 READ COMMITTED：本系统的并发控制靠"先按顺序加锁（工件 → 工序 / 采购行 / 待办），锁后再读"，
 * 锁后的普通读必须看到最新已提交数据。MySQL 默认的 REPEATABLE READ 会沿用加锁前第一次读建立的快照，
 * 读到等锁期间别人已提交前的旧数据（重复发第一次返厂待办、数量算错）。采购 / 发放原来就单独指定了 READ COMMITTED。
 * 注意：READ COMMITTED 下 InnoDB 不加间隙锁 / 临键锁，"锁一个范围（可能 0 行）挡住别人插入，再查有没有、没有就建"不再成立。
 * 防重复只能靠唯一索引（撞 P2002 时按已存在处理），或先锁一行确实存在的父行（工件、工单、发放单、预警行等）再查再建。
 *
 * 锁顺序（全系统统一）：工件（多个按 ID 排序，一次锁完）→ 工序 → 班组行（qms_supplier）。
 *   发 / 转待办算"谁负责"时对班组行加共享锁（flow/responsible.ts lock），换班组长对它加排他锁（flow/team-leaders.ts）。
 *   一个事务涉及多个工件时，要在锁第一个班组行之前把工件全部锁完。
 */
export const prisma = globalForPrisma.prisma ?? new PrismaClient({ transactionOptions: { isolationLevel: 'ReadCommitted' } })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

/**
 * 死锁 / 写冲突（数据库回滚了整个事务，可以整单重来）。
 * Prisma 自己生成的语句报 P2034；$queryRaw 里的 FOR UPDATE 死锁报 P2010，MySQL 错误码 1213 在 meta.code 里。
 */
export function isDeadlock(err: unknown) {
  const e = err as { code?: string; meta?: { code?: unknown }; message?: string }
  if (e?.code === 'P2034') return true
  if (e?.code === 'P2010' && String(e.meta?.code ?? '') === '1213') return true
  return /\b1213\b|deadlock/i.test(e?.message ?? '')
}
