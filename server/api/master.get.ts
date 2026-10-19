import { loadDeptIndex, resolveBusinessDept } from '../services/auth/departments'
import { departmentNames } from '../services/flow/names'

/**
 * 主数据下拉：外协单位（供应商在前，厂内外协班组 kind = TEAM 在后）、工序、用户（取自 QMS 副本）。
 * 用户的 department 是 QMS 部门原名称（给人看）；businessDept 是按部门对照换算出的业务部门编码（没对上为 null），前端排序、判断用它。
 */
export default defineFlowHandler(async () => {
  const [suppliers, processes, users] = await Promise.all([
    prisma.qmsSupplier.findMany({ where: { isDeleted: false }, orderBy: [{ kind: 'asc' }, { name: 'asc' }], select: { id: true, name: true, outsourcingMode: true, kind: true } }),
    prisma.qmsProcess.findMany({ where: { isDeleted: false }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    prisma.qmsUser.findMany({
      where: { isDeleted: false, status: 'ACTIVE' },
      orderBy: { username: 'asc' },
      select: { id: true, realName: true, username: true, departmentId: true },
    }),
  ])
  const [depts, index] = await Promise.all([departmentNames(users.map((u) => u.departmentId)), loadDeptIndex()])
  return {
    // 班组在下拉里标出来，与同名供应商区分
    suppliers: suppliers.map((s) => ({ ...s, label: s.kind === 'TEAM' ? `${s.name}（厂内班组）` : s.name })),
    processes,
    users: users.map((u) => ({
      id: u.id,
      name: u.realName || u.username,
      department: (u.departmentId && depts.get(u.departmentId)) || '',
      businessDept: resolveBusinessDept(u.departmentId, index),
    })),
  }
})
