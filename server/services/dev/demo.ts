/**
 * 演示数据与模拟报检，仅开发时可用（runtimeConfig.devTools）。
 * R2（QMS 同步）还没做，先用这些数据走通外协主链路。所有 ID 带 DEMO- 前缀，
 * 演示用户的 username 也带 DEMO- 前缀，便于和以后同步来的真实数据区分、一键清除。
 */
import { randomBytes } from 'node:crypto'
import { prisma } from '../../utils/prisma'
import { FlowError } from '../flow/errors'
import { matchPendingInspections } from '../flow/match'

const P = 'DEMO-'
const DAY = 86_400_000

const day = (offset: number) => {
  const d = new Date(Date.now() + offset * DAY)
  return new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`)
}

const WORK_ORDERS = [
  { workOrderNumber: `${P}WO-001`, customerName: '演示客户（铁路局）', projectName: '高铁架桥机（演示）', division: '桥机事业部', quantity: 1, deliveryDate: day(60) },
  { workOrderNumber: `${P}WO-002`, customerName: '演示客户（风电）', projectName: '风电叶片模具（演示）', division: '模具事业部', quantity: 2, deliveryDate: day(35) },
]

const SUPPLIERS = [
  { id: `${P}SUP-01`, name: '厂内组焊队', outsourcingMode: 'IN_PLANT' },
  { id: `${P}SUP-02`, name: '厂外组焊厂', outsourcingMode: 'EXTERNAL' },
  { id: `${P}SUP-03`, name: '机加厂', outsourcingMode: 'EXTERNAL' },
  { id: `${P}SUP-04`, name: '涂装厂', outsourcingMode: 'EXTERNAL' },
  { id: `${P}SUP-05`, name: '热处理厂', outsourcingMode: 'EXTERNAL' },
]

const PROCESSES = [
  { id: `${P}PRC-CUT`, name: '下料' },
  { id: `${P}PRC-WELD`, name: '组焊' },
  { id: `${P}PRC-MACH`, name: '机加' },
  { id: `${P}PRC-PAINT`, name: '涂装' },
  { id: `${P}PRC-ASSY`, name: '装配' },
]

// 模拟身份桥默认以 u-001 登录，所以这两个 ID 不带前缀
const USERS = [
  { id: 'u-001', username: `${P}u-001`, realName: '测试外协专员', department: '生产部', roleId: `${P}ROLE-OUTSOURCE`, roleName: '外协专员' },
  { id: 'u-002', username: `${P}u-002`, realName: '测试生产经理', department: '生产部', roleId: `${P}ROLE-PM`, roleName: '生产经理' },
]

const PART_ID = `${P}PART-001`
const STEPS = [
  { id: `${P}STEP-001`, seq: 1, processId: `${P}PRC-WELD`, mode: 'EXTERNAL_OUTSOURCE', supplierId: `${P}SUP-02`, ownerId: 'u-001' },
  { id: `${P}STEP-002`, seq: 2, processId: `${P}PRC-PAINT`, mode: 'EXTERNAL_OUTSOURCE', supplierId: `${P}SUP-04`, ownerId: 'u-001' },
  { id: `${P}STEP-003`, seq: 3, processId: `${P}PRC-ASSY`, mode: 'SELF', supplierId: null, ownerId: 'u-002' },
] as const

/** 幂等：已存在的记录不改（不会把走到一半的演示流程打回原形） */
export async function seedDemo() {
  const now = new Date()
  await prisma.$transaction(async (tx) => {
    for (const wo of WORK_ORDERS) {
      await tx.qmsWorkOrder.upsert({ where: { workOrderNumber: wo.workOrderNumber }, update: {}, create: { ...wo, status: 'IN_PROGRESS', updatedAt: now } })
    }
    for (const s of SUPPLIERS) {
      await tx.qmsSupplier.upsert({ where: { id: s.id }, update: {}, create: { ...s, category: '外协', updatedAt: now } })
    }
    for (const p of PROCESSES) {
      await tx.qmsProcess.upsert({ where: { id: p.id }, update: {}, create: { ...p, supplierSource: 'Supplier', updatedAt: now } })
    }
    for (const u of USERS) {
      // 已有同 ID 的真实用户（同步来的）时不覆盖
      await tx.qmsUser.upsert({ where: { id: u.id }, update: {}, create: { ...u, status: 'ACTIVE', updatedAt: now } })
    }
    await tx.part.upsert({
      where: { id: PART_ID },
      update: {},
      create: { id: PART_ID, workOrderNumber: `${P}WO-001`, name: '主梁结构件', drawingNo: `${P}DWG-001`, quantity: 2, qmsPartId: `${P}BOM-001` },
    })
    for (const s of STEPS) {
      await tx.routeStep.upsert({ where: { id: s.id }, update: {}, create: { ...s, partId: PART_ID } })
    }
    // 第一道没有上一道触发待办，演示时直接给外协专员一条"安排发出"
    await tx.todo.upsert({
      where: { id: `${P}TODO-001` },
      update: {},
      create: { id: `${P}TODO-001`, ownerId: 'u-001', action: 'ARRANGE_SEND', refType: 'step', refId: `${P}STEP-001` },
    })
  })
  return { workOrders: WORK_ORDERS.length, suppliers: SUPPLIERS.length, processes: PROCESSES.length, users: USERS.length, parts: 1 }
}

/** 只删 DEMO 数据，以及引用了它们的工件、步骤、事件、待办和待确认记录 */
export async function resetDemo() {
  return prisma.$transaction(async (tx) => {
    const parts = await tx.part.findMany({ where: { OR: [{ id: { startsWith: P } }, { workOrderNumber: { startsWith: P } }] }, select: { id: true } })
    const partIds = parts.map((p) => p.id)
    const steps = await tx.routeStep.findMany({
      where: { OR: [{ partId: { in: partIds } }, { processId: { startsWith: P } }, { supplierId: { startsWith: P } }] },
      select: { id: true },
    })
    const stepIds = steps.map((s) => s.id)
    const inspections = await tx.qmsInspection.findMany({ where: { OR: [{ id: { startsWith: P } }, { workOrderNumber: { startsWith: P } }] }, select: { id: true } })
    const insIds = inspections.map((i) => i.id)

    // 开发工具专用：flow_event 平时只新增，这里是清理演示数据
    const events = await tx.flowEvent.deleteMany({ where: { OR: [{ stepId: { in: stepIds } }, { qmsInspectionId: { in: insIds } }] } })
    const todos = await tx.todo.deleteMany({ where: { OR: [{ id: { startsWith: P } }, { refType: 'step', refId: { in: stepIds } }] } })
    const alerts = await tx.alert.deleteMany({ where: { refType: 'step', refId: { in: stepIds } } })
    const unmatched = await tx.unmatchedInspection.deleteMany({ where: { qmsInspectionId: { in: insIds } } })
    const stepsDeleted = await tx.routeStep.deleteMany({ where: { id: { in: stepIds } } })
    const partsDeleted = await tx.part.deleteMany({ where: { id: { in: partIds } } })
    await tx.qmsInspection.deleteMany({ where: { id: { in: insIds } } })
    await tx.qmsWorkOrder.deleteMany({ where: { workOrderNumber: { startsWith: P } } })
    await tx.qmsSupplier.deleteMany({ where: { id: { startsWith: P } } })
    await tx.qmsProcess.deleteMany({ where: { id: { startsWith: P } } })
    await tx.qmsUser.deleteMany({ where: { username: { startsWith: P } } })
    return {
      parts: partsDeleted.count,
      steps: stepsDeleted.count,
      events: events.count,
      todos: todos.count,
      alerts: alerts.count,
      unmatched: unmatched.count,
      inspections: insIds.length,
    }
  })
}

export interface DemoInspectionInput {
  workOrderNumber: string
  partId?: string | null
  partName?: string | null
  processId?: string | null
  processName?: string | null
  supplierId?: string | null
  quantity: number
}

/** 模拟 QMS 新增一条返厂报检，然后立即跑一轮匹配 */
export async function createDemoInspection(input: DemoInspectionInput) {
  const [process, supplier] = await Promise.all([
    input.processId ? prisma.qmsProcess.findUnique({ where: { id: input.processId } }) : null,
    input.supplierId ? prisma.qmsSupplier.findUnique({ where: { id: input.supplierId } }) : null,
  ])
  const partName = input.partName?.trim() || ''
  const processName = input.processName?.trim() || process?.name || ''
  if (!input.partId && !partName) throw new FlowError('物料 ID 和物料名称至少填一个')
  const now = new Date()
  const id = `${P}INS-${now.getTime()}-${randomBytes(3).toString('hex')}`
  await prisma.qmsInspection.create({
    data: {
      id,
      requestNo: `${P}RQ-${now.getTime()}`,
      workOrderNumber: input.workOrderNumber,
      partId: input.partId || null,
      partName,
      processId: input.processId || null,
      processName,
      supplierId: input.supplierId || null,
      supplierName: supplier?.name ?? null,
      responsibilityType: input.supplierId ? 'SUPPLIER' : null,
      quantity: input.quantity,
      status: 'SUBMITTED',
      inspectionResult: 'PASS',
      submittedAt: now,
      updatedAt: now,
    },
  })
  const results = await matchPendingInspections()
  return { inspectionId: id, result: results.find((r) => r.inspectionId === id) ?? null, processed: results.length }
}
