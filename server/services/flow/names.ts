/** 把 QMS 主数据 ID 翻译成名称，供列表展示。主数据表都不大，按需批量查。 */
import { prisma } from '../../utils/prisma'

export interface NameMaps {
  process: Map<string, string>
  supplier: Map<string, string>
  user: Map<string, string>
}

const uniq = (ids: (string | null | undefined)[]) => [...new Set(ids.filter((x): x is string => !!x))]

/** db：在事务里调用时传事务客户端 */
export async function loadNames(
  ids: { process?: (string | null)[]; supplier?: (string | null)[]; user?: (string | null)[] },
  db: Pick<typeof prisma, 'qmsProcess' | 'qmsSupplier' | 'qmsUser'> = prisma,
): Promise<NameMaps> {
  const [processes, suppliers, users] = await Promise.all([
    ids.process?.length ? db.qmsProcess.findMany({ where: { id: { in: uniq(ids.process) } }, select: { id: true, name: true } }) : [],
    ids.supplier?.length ? db.qmsSupplier.findMany({ where: { id: { in: uniq(ids.supplier) } }, select: { id: true, name: true } }) : [],
    ids.user?.length ? db.qmsUser.findMany({ where: { id: { in: uniq(ids.user) } }, select: { id: true, realName: true, username: true } }) : [],
  ])
  return {
    process: new Map(processes.map((p) => [p.id, p.name])),
    supplier: new Map(suppliers.map((s) => [s.id, s.name])),
    user: new Map(users.map((u) => [u.id, u.realName || u.username])),
  }
}

export const MODE_TEXT = { SELF: '自制', IN_PLANT_OUTSOURCE: '厂内外协', EXTERNAL_OUTSOURCE: '厂外外协' } as const

/**
 * 用户所在部门的名称：QMS 的 users.department 存的是部门 ID，经 qms_department 换成名称。
 * 部门负责人（notify_role.department）、异常默认责任部门都按名称配置，所以比较前先换成名称。
 * 找不到部门（未同步或已删除）的用户不在结果里。
 */
export async function userDepartmentNames(userIds: (string | null | undefined)[]): Promise<Map<string, string>> {
  const ids = uniq(userIds)
  if (!ids.length) return new Map()
  const users = await prisma.qmsUser.findMany({ where: { id: { in: ids } }, select: { id: true, departmentId: true } })
  const names = await departmentNames(users.map((u) => u.departmentId))
  const out = new Map<string, string>()
  for (const u of users) {
    const name = u.departmentId ? names.get(u.departmentId) : undefined
    if (name) out.set(u.id, name)
  }
  return out
}

/** 部门 ID → 名称（含已删除的部门：历史数据仍按原名称显示） */
export async function departmentNames(departmentIds: (string | null | undefined)[]): Promise<Map<string, string>> {
  const ids = uniq(departmentIds)
  if (!ids.length) return new Map()
  const rows = await prisma.qmsDepartment.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
  return new Map(rows.map((d) => [d.id, d.name]))
}
