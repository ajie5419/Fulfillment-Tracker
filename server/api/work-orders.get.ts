/** 工单列表（QMS 副本，未删除的），交期近的在前 */
export default defineFlowHandler(async () => {
  return prisma.qmsWorkOrder.findMany({
    where: { isDeleted: false },
    orderBy: [{ deliveryDate: 'asc' }, { workOrderNumber: 'asc' }],
    select: { workOrderNumber: true, customerName: true, projectName: true, deliveryDate: true, status: true, quantity: true },
  })
})
