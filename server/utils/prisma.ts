import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

/**
 * 事务默认 READ COMMITTED：本系统的并发控制靠"先按顺序加锁（工件 → 工序 / 采购行 / 待办），锁后再读"，
 * 锁后的普通读必须看到最新已提交数据。MySQL 默认的 REPEATABLE READ 会沿用加锁前第一次读建立的快照，
 * 读到等锁期间别人已提交前的旧数据（重复发第一次返厂待办、数量算错）。采购 / 发放原来就单独指定了 READ COMMITTED。
 */
export const prisma = globalForPrisma.prisma ?? new PrismaClient({ transactionOptions: { isolationLevel: 'ReadCommitted' } })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
