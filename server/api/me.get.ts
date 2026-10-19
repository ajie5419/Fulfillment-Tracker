import { BUSINESS_DEPT_NAME } from '../services/auth/departments'
import { menuSections, permissionFlags } from '../services/auth/permissions'
import { departmentNames } from '../services/flow/names'

/**
 * 当前用户。部门和角色来自 QMS 用户副本（部门 ID 经 qms_department 换成名称）。devTools 决定是否显示"演示工具"菜单，isAdmin 决定"设置"菜单。
 * deptHeadOf：担任负责人的部门（异常列表默认筛"本部门"）；limited：只能看自己负责的工单（项目经理）。
 * 权限方案 R13：businessDept 是 QMS 部门经"部门对照"换算出的业务部门（null = 其他）；menu 是电脑端可见的菜单分区；
 * can 是按角色的操作标志（"该工单项目经理""该工序责任人"由前端用 pmOf / id 补上，后端仍是最终判断）。
 */
export default defineEventHandler(async (event) => {
  const user = requireUser(event)
  const [qmsUser, scope, ctx] = await Promise.all([
    prisma.qmsUser.findUnique({ where: { id: user.qmsUserId }, select: { departmentId: true, roleName: true } }),
    getScope(event),
    getRoleContext(event),
  ])
  return {
    deptHeadOf: ctx.deptHeadOf,
    roles: ctx.roles,
    limited: !scope.all,
    id: user.qmsUserId,
    name: user.name,
    department: (qmsUser?.departmentId && (await departmentNames([qmsUser.departmentId])).get(qmsUser.departmentId)) || null,
    businessDept: ctx.businessDept,
    businessDeptName: ctx.businessDept ? BUSINESS_DEPT_NAME[ctx.businessDept] : null,
    roleName: qmsUser?.roleName ?? null,
    devTools: Boolean(useRuntimeConfig(event).devTools),
    isAdmin: ctx.isAdmin,
    pmOf: [...ctx.pmOf],
    menu: menuSections(ctx),
    can: permissionFlags(ctx),
  }
})
