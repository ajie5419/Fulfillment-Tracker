/** 主数据下拉：外协厂、工序、用户（取自 QMS 副本） */
export default defineFlowHandler(async () => {
  const [suppliers, processes, users] = await Promise.all([
    prisma.qmsSupplier.findMany({ where: { isDeleted: false }, orderBy: { name: 'asc' }, select: { id: true, name: true, outsourcingMode: true } }),
    prisma.qmsProcess.findMany({ where: { isDeleted: false }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    prisma.qmsUser.findMany({
      where: { isDeleted: false, status: 'ACTIVE' },
      orderBy: { username: 'asc' },
      select: { id: true, realName: true, username: true, department: true },
    }),
  ])
  return { suppliers, processes, users: users.map((u) => ({ id: u.id, name: u.realName || u.username, department: u.department })) }
})
