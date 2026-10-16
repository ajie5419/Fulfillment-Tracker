/** 把 QMS 主数据 ID 翻译成名称，供列表展示。主数据表都不大，按需批量查。 */
import { prisma } from '../../utils/prisma'

export interface NameMaps {
  process: Map<string, string>
  supplier: Map<string, string>
  user: Map<string, string>
}

const uniq = (ids: (string | null | undefined)[]) => [...new Set(ids.filter((x): x is string => !!x))]

export async function loadNames(ids: { process?: (string | null)[]; supplier?: (string | null)[]; user?: (string | null)[] }): Promise<NameMaps> {
  const [processes, suppliers, users] = await Promise.all([
    ids.process?.length ? prisma.qmsProcess.findMany({ where: { id: { in: uniq(ids.process) } }, select: { id: true, name: true } }) : [],
    ids.supplier?.length ? prisma.qmsSupplier.findMany({ where: { id: { in: uniq(ids.supplier) } }, select: { id: true, name: true } }) : [],
    ids.user?.length ? prisma.qmsUser.findMany({ where: { id: { in: uniq(ids.user) } }, select: { id: true, realName: true, username: true } }) : [],
  ])
  return {
    process: new Map(processes.map((p) => [p.id, p.name])),
    supplier: new Map(suppliers.map((s) => [s.id, s.name])),
    user: new Map(users.map((u) => [u.id, u.realName || u.username])),
  }
}

export const MODE_TEXT = { SELF: '自制', IN_PLANT_OUTSOURCE: '厂内外协', EXTERNAL_OUTSOURCE: '厂外外协' } as const
