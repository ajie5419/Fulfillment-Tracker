/** 当前用户。部门和角色来自 QMS 用户副本（R2 同步后才有）。devTools 决定是否显示"演示工具"菜单。 */
export default defineEventHandler(async (event) => {
  const user = requireUser(event)
  const qmsUser = await prisma.qmsUser.findUnique({
    where: { id: user.qmsUserId },
    select: { department: true, roleName: true },
  })
  return {
    id: user.qmsUserId,
    name: user.name,
    department: qmsUser?.department ?? null,
    roleName: qmsUser?.roleName ?? null,
    devTools: Boolean(useRuntimeConfig(event).devTools),
  }
})
