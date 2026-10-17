import { departmentNames } from '../services/flow/names'

/**
 * 当前用户。部门和角色来自 QMS 用户副本（部门 ID 经 qms_department 换成名称）。devTools 决定是否显示"演示工具"菜单，isAdmin 决定"设置"菜单。
 * deptHeadOf：担任负责人的部门（异常列表默认筛"本部门"）；limited：只能看自己负责的工单（项目经理）。
 */
export default defineEventHandler(async (event) => {
  const user = requireUser(event)
  const [qmsUser, roles, scope] = await Promise.all([
    prisma.qmsUser.findUnique({ where: { id: user.qmsUserId }, select: { departmentId: true, roleName: true } }),
    prisma.notifyRole.findMany({ where: { userId: user.qmsUserId }, select: { role: true, department: true } }),
    getScope(event),
  ])
  return {
    deptHeadOf: [...new Set(roles.filter((r) => r.role === 'DEPT_HEAD' && r.department).map((r) => r.department!))],
    roles: [...new Set(roles.map((r) => r.role))],
    limited: !scope.all,
    id: user.qmsUserId,
    name: user.name,
    department: (qmsUser?.departmentId && (await departmentNames([qmsUser.departmentId])).get(qmsUser.departmentId)) || null,
    roleName: qmsUser?.roleName ?? null,
    devTools: Boolean(useRuntimeConfig(event).devTools),
    isAdmin: isAdmin(event, user),
  }
})
