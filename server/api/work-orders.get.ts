/** 工单列表（QMS 副本，未删除的），交期近的在前；只列当前用户可见的（项目经理只看自己负责的） */
export default defineFlowHandler(async (event) => {
  const visible = scopeWorkOrders(await getScope(event))
  return prisma.qmsWorkOrder.findMany({
    where: { isDeleted: false, ...(visible ? { workOrderNumber: { in: visible } } : {}) },
    orderBy: [{ deliveryDate: 'asc' }, { workOrderNumber: 'asc' }],
    select: { workOrderNumber: true, customerName: true, projectName: true, deliveryDate: true, status: true, quantity: true },
  })
})
