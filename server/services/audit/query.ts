import { prisma } from '../../utils/prisma'

/** The admin route is the only public entry; snapshots may include financial amounts. */
export async function listAudit(input: { page: number; pageSize: number; requestId?: string; entityType?: string; entityId?: string }) {
  const { page, pageSize, ...where } = input
  const [rows, total] = await prisma.$transaction([
    prisma.auditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
    prisma.auditLog.count({ where }),
  ])
  return { rows, total, page, pageSize }
}
