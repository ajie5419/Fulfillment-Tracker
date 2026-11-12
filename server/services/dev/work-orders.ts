import type { Prisma, QmsWorkOrder } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { qmsWorkOrderSchema } from '../sync/resources'
import { QmsRejected, type QmsWorkOrderApi, type UpdateWorkOrderBody } from '../sync/write-client'

export const DEMO_CUSTOMERS = [
  { id: 'DEMO-CUSTOMER-RAIL', name: '演示客户（铁路局）' },
  { id: 'DEMO-CUSTOMER-WIND', name: '演示客户（风电）' },
  { id: 'DEMO-CUSTOMER-PORT', name: '演示客户（港口）' },
]

function gatewayRow(row: QmsWorkOrder) {
  return qmsWorkOrderSchema.parse({ ...row, effectiveTime: row.effectiveTime?.toISOString() ?? null, deliveryDate: row.deliveryDate.toISOString(), updatedAt: row.updatedAt.toISOString() })
}

function assertDemoNumber(no: string) {
  if (!no.startsWith('DEMO-')) throw new QmsRejected('演示工单号请以 DEMO- 开头，例如 DEMO-WO-004，方便统一清除和重新试用', 400, 'BAD_REQUEST')
}

function customer(id: string) {
  const value = DEMO_CUSTOMERS.find(row => row.id === id)
  if (!value) throw new QmsRejected('请选择有效的演示客户', 400, 'BAD_REQUEST')
  return { customerNameId: value.id, customerName: value.name }
}

async function division(db: Prisma.TransactionClient, id: string | null | undefined) {
  if (!id) return { divisionId: null, division: null }
  const row = await db.qmsDepartment.findFirst({ where: { id, isDeleted: false }, select: { name: true } })
  if (!row) throw new QmsRejected('所选部门不存在', 400, 'BAD_REQUEST')
  return { divisionId: id, division: row.name }
}

/**
 * The isolated demo has no remote QMS. Implement the existing gateway contract
 * against its dedicated database, preserving normal permissions and recovery.
 * CAS updates prevent stale editors from overwriting a newer demo work order.
 */
export function demoWorkOrderApi(): QmsWorkOrderApi {
  async function change(no: string, body: UpdateWorkOrderBody, cancel = false) {
    assertDemoNumber(no)
    return prisma.$transaction(async tx => {
      const row = await tx.qmsWorkOrder.findUnique({ where: { workOrderNumber: no } })
      if (!row || row.isDeleted) throw new QmsRejected('演示工单不存在', 404, 'NOT_FOUND')
      if (cancel && row.status === 'CANCELLED') return gatewayRow(row)
      if (row.status === 'CANCELLED') throw new QmsRejected('已取消的工单不能修改', 400, 'BAD_REQUEST')
      if (row.version !== body.version) throw new QmsRejected('工单已被别人修改，请刷新后再改', 409, 'OPTIMISTIC_LOCK_CONFLICT')
      const data: Prisma.QmsWorkOrderUpdateManyMutationInput = {
        version: { increment: 1 }, updatedAt: new Date(),
        ...(cancel ? { status: 'CANCELLED' } : {}),
      }
      if (!cancel) {
        if (body.customerNameId !== undefined) Object.assign(data, customer(body.customerNameId))
        if (body.divisionId !== undefined) Object.assign(data, await division(tx, body.divisionId))
        if (body.projectName !== undefined) data.projectName = body.projectName
        if (body.quantity !== undefined) data.quantity = body.quantity
        if (body.deliveryDate !== undefined) data.deliveryDate = new Date(body.deliveryDate)
        if (body.status !== undefined) data.status = body.status
      }
      const result = await tx.qmsWorkOrder.updateMany({ where: { workOrderNumber: no, version: body.version, isDeleted: false, status: { not: 'CANCELLED' } }, data })
      if (!result.count) throw new QmsRejected('工单已被别人修改，请刷新后再改', 409, 'OPTIMISTIC_LOCK_CONFLICT')
      return gatewayRow(await tx.qmsWorkOrder.findUniqueOrThrow({ where: { workOrderNumber: no } }))
    })
  }
  return {
    listCustomers: async () => DEMO_CUSTOMERS,
    async findWorkOrder(no) {
      const row = await prisma.qmsWorkOrder.findUnique({ where: { workOrderNumber: no } })
      return row ? gatewayRow(row) : null
    },
    async createWorkOrder(body) {
      assertDemoNumber(body.workOrderNumber)
      try {
        // Strip local-only Date fields before the shared recovery JSON serialization.
        return gatewayRow(await prisma.$transaction(async tx => tx.qmsWorkOrder.create({ data: {
          workOrderNumber: body.workOrderNumber,
          ...customer(body.customerNameId),
          ...await division(tx, body.divisionId),
          projectName: body.projectName ?? null,
          quantity: body.quantity,
          deliveryDate: new Date(body.deliveryDate),
          status: 'OPEN', version: 1, updatedAt: new Date(),
        } })))
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
          throw new QmsRejected('演示工单号已存在，请使用其他工单号', 409, 'WORK_ORDER_EXISTS')
        }
        throw error
      }
    },
    updateWorkOrder: (no, body) => change(no, body),
    cancelWorkOrder: (no, body) => change(no, body, true),
  }
}
