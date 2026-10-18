/**
 * 演示数据与模拟报检，仅开发时可用（runtimeConfig.devTools）。
 * 不连 QMS 时用这些数据走通外协主链路。所有 ID 带 DEMO- 前缀，演示用户的 username 也带 DEMO- 前缀，
 * 与同步来的真实数据共存、一键清除（只删 DEMO- 行，绝不删同步来的真实行）。
 * 配置了 QMS 同步时不写演示用户：演示用户的 ID（u-001 等）不带前缀，会和 QMS 真实用户占同一批 ID，用户以 QMS 为准。
 */
import { randomBytes } from 'node:crypto'
import { prisma } from '../../utils/prisma'
import { DEFAULT_THRESHOLDS } from '../alerts/rules'
import { FlowError } from '../flow/errors'
import { matchInspection, matchPendingInspections } from '../flow/match'
import { syncNonconforming } from '../issues/nonconforming'
import { removeUploadFiles } from '../issues/uploads'
import type { QmsBomItem } from '../bom/client'

const P = 'DEMO-'
const DAY = 86_400_000

const day = (offset: number) => {
  const d = new Date(Date.now() + offset * DAY)
  return new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`)
}

const WORK_ORDERS = [
  { workOrderNumber: `${P}WO-001`, customerName: '演示客户（铁路局）', projectName: '高铁架桥机（演示）', division: '桥机事业部', quantity: 1, deliveryDate: day(35) },
  { workOrderNumber: `${P}WO-002`, customerName: '演示客户（风电）', projectName: '风电叶片模具（演示）', division: '模具事业部', quantity: 2, deliveryDate: day(60) },
  // 没有设项目经理：演示"项目经理只看到自己负责的工单"（u-003 看不到这一单）
  { workOrderNumber: `${P}WO-003`, customerName: '演示客户（港口）', projectName: '港口门机（演示）', division: '起重事业部', quantity: 1, deliveryDate: day(90) },
]
/** 项目经理 u-003 负责的演示工单 */
const PM_WORK_ORDERS = [`${P}WO-001`, `${P}WO-002`]

// 异常分类的默认责任部门按名称匹配这些部门（方案 6.4）
const DEPARTMENTS = [
  { id: `${P}DEPT-TECH`, name: '技术部' },
  { id: `${P}DEPT-PUR`, name: '采购部' },
  { id: `${P}DEPT-FIN`, name: '财务部' },
  { id: `${P}DEPT-QA`, name: '质量部' },
  { id: `${P}DEPT-PROD`, name: '生产部' },
  { id: `${P}DEPT-PROJ`, name: '项目部' },
  { id: `${P}DEPT-LEAD`, name: '公司领导' },
]

const SUPPLIERS = [
  { id: `${P}SUP-01`, name: '厂内组焊队', outsourcingMode: 'IN_PLANT', kind: 'TEAM' }, // 厂内外协班组
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

// 模拟身份桥按这些 ID 登录（授权页可选 u-001 ~ u-006），所以 ID 不带前缀。QMS 用户的部门存部门 ID
const USERS = [
  { id: 'u-001', username: `${P}u-001`, realName: '测试外协专员', departmentId: `${P}DEPT-PROD`, roleId: `${P}ROLE-OUTSOURCE`, roleName: '外协专员' },
  { id: 'u-002', username: `${P}u-002`, realName: '测试生产经理', departmentId: `${P}DEPT-PROD`, roleId: `${P}ROLE-PM`, roleName: '生产经理' },
  { id: 'u-003', username: `${P}u-003`, realName: '测试项目经理', departmentId: `${P}DEPT-PROJ`, roleId: `${P}ROLE-PROJ`, roleName: '项目经理' },
  { id: 'u-004', username: `${P}u-004`, realName: '测试项目部负责人', departmentId: `${P}DEPT-PROJ`, roleId: `${P}ROLE-PROJ-HEAD`, roleName: '部门负责人' },
  { id: 'u-005', username: `${P}u-005`, realName: '测试分管领导', departmentId: `${P}DEPT-LEAD`, roleId: `${P}ROLE-LEADER`, roleName: '领导' },
  { id: 'u-006', username: `${P}u-006`, realName: '测试质量负责人', departmentId: `${P}DEPT-QA`, roleId: `${P}ROLE-QA-HEAD`, roleName: '部门负责人' },
]

// 预警升级阶梯的通知对象（方案 6.2）
const NOTIFY_ROLES = [
  { id: `${P}ROLE-1`, role: 'OUTSOURCE_COORDINATOR', userId: 'u-001', department: null },
  { id: `${P}ROLE-2`, role: 'DEPT_HEAD', userId: 'u-002', department: '生产部' },
  { id: `${P}ROLE-3`, role: 'PROJECT_DEPT_HEAD', userId: 'u-004', department: null },
  { id: `${P}ROLE-4`, role: 'LEADER', userId: 'u-005', department: null },
  { id: `${P}ROLE-5`, role: 'DEPT_HEAD', userId: 'u-006', department: '质量部' },
] as const

const PART_ID = `${P}PART-001`
const STEPS = [
  { id: `${P}STEP-001`, seq: 1, processId: `${P}PRC-WELD`, mode: 'EXTERNAL_OUTSOURCE', supplierId: `${P}SUP-02`, ownerId: 'u-001' },
  { id: `${P}STEP-002`, seq: 2, processId: `${P}PRC-PAINT`, mode: 'EXTERNAL_OUTSOURCE', supplierId: `${P}SUP-04`, ownerId: 'u-001' },
  { id: `${P}STEP-003`, seq: 3, processId: `${P}PRC-ASSY`, mode: 'SELF', supplierId: null, ownerId: 'u-002' },
] as const

/**
 * 演示 BOM（R8）：模拟 QMS 项目 BOM，演示工具开着时 DEMO- 工单的"从 QMS BOM 导入"读这里，不连 QMS。
 * 第 3 行的"探伤"在 QMS 没有关联工序 ID，演示"跳过并提示"。
 */
const DEMO_BOMS: Record<string, QmsBomItem[]> = {
  [`${P}WO-002`]: [
    {
      id: `${P}BOMROW-201`,
      partId: `${P}BOM-201`,
      partName: '模具底座',
      partNumber: `${P}DWG-201`,
      material: 'Q355B',
      quantity: 2,
      unit: '件',
      remarks: null,
      processes: [
        { processId: `${P}PRC-CUT`, processName: '下料' },
        { processId: `${P}PRC-WELD`, processName: '组焊' },
        { processId: `${P}PRC-MACH`, processName: '机加' },
      ],
    },
    {
      id: `${P}BOMROW-202`,
      partId: `${P}BOM-202`,
      partName: '加热板',
      partNumber: `${P}DWG-202`,
      material: '45#',
      quantity: 4,
      unit: '件',
      remarks: null,
      processes: [
        { processId: `${P}PRC-MACH`, processName: '机加' },
        { processId: `${P}PRC-PAINT`, processName: '涂装' },
      ],
    },
    {
      id: `${P}BOMROW-203`,
      partId: `${P}BOM-203`,
      partName: '横梁',
      partNumber: `${P}DWG-203`,
      material: 'Q235B',
      quantity: 1,
      unit: '件',
      remarks: '有一道工序在 QMS 没有关联工序 ID',
      processes: [
        { processId: `${P}PRC-WELD`, processName: '组焊' },
        { processId: null, processName: '探伤' },
        { processId: `${P}PRC-PAINT`, processName: '涂装' },
      ],
    },
  ],
}

/** 演示 BOM：只有写过演示数据（DEMO- 工单存在）时有内容 */
export async function demoBom(workOrderNumber: string): Promise<QmsBomItem[]> {
  const wo = await prisma.qmsWorkOrder.findFirst({ where: { workOrderNumber, isDeleted: false }, select: { workOrderNumber: true } })
  return wo ? structuredClone(DEMO_BOMS[workOrderNumber] ?? []) : []
}

// 演示路线模板（R8）
const TEMPLATE = {
  id: `${P}TPL-001`,
  name: '结构件（演示）：下料 → 组焊 → 涂装',
  description: '演示模板：结构件常见路线，组焊、涂装走厂外外协',
  steps: [
    { seq: 1, processId: `${P}PRC-CUT`, mode: 'SELF', supplierId: null, defaultDays: 2 },
    { seq: 2, processId: `${P}PRC-WELD`, mode: 'EXTERNAL_OUTSOURCE', supplierId: `${P}SUP-02`, defaultDays: 7 },
    { seq: 3, processId: `${P}PRC-PAINT`, mode: 'EXTERNAL_OUTSOURCE', supplierId: `${P}SUP-04`, defaultDays: 5 },
  ],
} as const

/**
 * 幂等：已存在的记录不改（不会把走到一半的演示流程打回原形）。
 * skipUsers：配置了 QMS 同步时为 true，不写演示用户（避免和同步来的真实用户冲突）
 */
export async function seedDemo(opts: { skipUsers?: boolean } = {}) {
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
    for (const d of DEPARTMENTS) {
      await tx.qmsDepartment.upsert({ where: { id: d.id }, update: {}, create: { ...d, parentId: '0', status: 1, updatedAt: now } })
    }
    for (const u of opts.skipUsers ? [] : USERS) {
      // 已有同 ID 的真实用户（同步来的）时不覆盖
      await tx.qmsUser.upsert({ where: { id: u.id }, update: {}, create: { ...u, status: 'ACTIVE', updatedAt: now } })
    }
    for (const r of NOTIFY_ROLES) {
      await tx.notifyRole.upsert({ where: { id: r.id }, update: {}, create: r })
    }
    // 演示工单 001、002 的项目经理是 u-003；003 不设项目经理
    for (const wo of WORK_ORDERS) {
      const pm = PM_WORK_ORDERS.includes(wo.workOrderNumber) ? 'u-003' : null
      await tx.workOrderExt.upsert({
        where: { workOrderNumber: wo.workOrderNumber },
        update: {},
        create: { workOrderNumber: wo.workOrderNumber, projectManagerId: pm, isPilot: true },
      })
    }
    // 默认阈值（迁移里也写了；这里补上被清掉的）
    for (const [rule, t] of Object.entries(DEFAULT_THRESHOLDS)) {
      await tx.threshold.upsert({ where: { rule: rule as keyof typeof DEFAULT_THRESHOLDS }, update: {}, create: { rule: rule as keyof typeof DEFAULT_THRESHOLDS, ...t } })
    }
    await tx.part.upsert({
      where: { id: PART_ID },
      update: {},
      create: { id: PART_ID, workOrderNumber: `${P}WO-001`, name: '主梁结构件', drawingNo: `${P}DWG-001`, quantity: 2, qmsPartId: `${P}BOM-001` },
    })
    for (const s of STEPS) {
      await tx.routeStep.upsert({ where: { id: s.id }, update: {}, create: { ...s, partId: PART_ID } })
    }
    // 模板按 ID 判断是否已有；同名的真实模板存在时不写（名称唯一）
    if (!(await tx.routeTemplate.findFirst({ where: { OR: [{ id: TEMPLATE.id }, { name: TEMPLATE.name }] }, select: { id: true } }))) {
      const { steps, ...t } = TEMPLATE
      await tx.routeTemplate.create({ data: { ...t, steps: { create: steps.map((x) => ({ ...x })) } } })
    }
    // 第一道没有上一道触发待办，演示时直接给外协专员一条"安排发出"
    await tx.todo.upsert({
      where: { id: `${P}TODO-001` },
      update: {},
      create: { id: `${P}TODO-001`, ownerId: 'u-001', action: 'ARRANGE_SEND', refType: 'step', refId: `${P}STEP-001` },
    })
  })
  return {
    workOrders: WORK_ORDERS.length,
    suppliers: SUPPLIERS.length,
    processes: PROCESSES.length,
    departments: DEPARTMENTS.length,
    users: opts.skipUsers ? 0 : USERS.length,
    notifyRoles: NOTIFY_ROLES.length,
    parts: 1,
    templates: 1,
  }
}

/**
 * 只删 DEMO 数据，以及引用了它们的工件、步骤、事件、待办、待确认记录、异常（含处理日志、上传的照片）、预警和提醒；
 * 通知对象、工单项目经理一并清掉，阈值恢复默认（删掉后按默认值，下次写入演示数据时再补上）。停工日不动。
 * uploadDir 给了时顺带删掉照片文件。
 */
export async function resetDemo(uploadDir?: string) {
  const result = await prisma.$transaction(async (tx) => {
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
    const issueRows = await tx.issue.findMany({ where: { workOrderNumber: { startsWith: P } }, select: { id: true } })
    const issueIds = issueRows.map((i) => i.id)
    const alertRows = await tx.alert.findMany({
      where: {
        OR: [
          { refType: 'step', refId: { in: stepIds } },
          { refType: 'unmatched', refId: { in: insIds } },
          { refType: 'issue', refId: { in: issueIds } },
        ],
      },
      select: { id: true },
    })
    const alertIds = alertRows.map((a) => a.id)
    const demoUsers = (await tx.qmsUser.findMany({ where: { username: { startsWith: P } }, select: { id: true } })).map((u) => u.id)
    const uploads = await tx.uploadFile.findMany({ where: { OR: [{ issueId: { in: issueIds } }, { uploaderId: { in: demoUsers } }] }, select: { id: true, storedName: true } })
    await tx.uploadFile.deleteMany({ where: { id: { in: uploads.map((u) => u.id) } } })
    const issues = await tx.issue.deleteMany({ where: { id: { in: issueIds } } }) // 处理日志级联删除
    const reminders = await tx.reminder.deleteMany({ where: { OR: [{ alertId: { in: alertIds } }, { userId: { in: demoUsers } }] } })
    const alerts = await tx.alert.deleteMany({ where: { id: { in: alertIds } } })
    await tx.notifyRole.deleteMany({ where: { OR: [{ id: { startsWith: P } }, { userId: { in: demoUsers } }] } })
    await tx.workOrderExt.deleteMany({ where: { workOrderNumber: { startsWith: P } } })
    await tx.threshold.deleteMany()
    const unmatched = await tx.unmatchedInspection.deleteMany({ where: { qmsInspectionId: { in: insIds } } })
    const stepsDeleted = await tx.routeStep.deleteMany({ where: { id: { in: stepIds } } })
    const partsDeleted = await tx.part.deleteMany({ where: { id: { in: partIds } } })
    // 演示模板，以及引用了演示工序/外协厂的模板（演示主数据删掉后它们没法用）
    const templates = await tx.routeTemplate.deleteMany({
      where: { OR: [{ id: { startsWith: P } }, { steps: { some: { OR: [{ processId: { startsWith: P } }, { supplierId: { startsWith: P } }] } } }] },
    })
    await tx.qmsInspection.deleteMany({ where: { id: { in: insIds } } })
    await tx.qmsWorkOrder.deleteMany({ where: { workOrderNumber: { startsWith: P } } })
    await tx.qmsSupplier.deleteMany({ where: { id: { startsWith: P } } })
    await tx.qmsProcess.deleteMany({ where: { id: { startsWith: P } } })
    await tx.qmsUser.deleteMany({ where: { username: { startsWith: P } } })
    await tx.qmsDepartment.deleteMany({ where: { id: { startsWith: P } } })
    return {
      storedNames: uploads.map((u) => u.storedName),
      issues: issues.count,
      uploads: uploads.length,
      parts: partsDeleted.count,
      steps: stepsDeleted.count,
      events: events.count,
      todos: todos.count,
      alerts: alerts.count,
      reminders: reminders.count,
      unmatched: unmatched.count,
      inspections: insIds.length,
      templates: templates.count,
    }
  })
  const { storedNames, ...counts } = result
  if (uploadDir) await removeUploadFiles(uploadDir, storedNames)
  return counts
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
      workOrderNumbers: [input.workOrderNumber],
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
  // 先匹配这一条（工单下还没建工件时也给出结果），再顺带处理其他待处理的
  const result = await matchInspection(id)
  const results = await matchPendingInspections()
  const nonconforming = await syncNonconforming()
  return { inspectionId: id, result, processed: results.length + 1, nonconforming }
}

/** 演示用的报检列表（模拟检验结论时选择） */
export async function listDemoInspections() {
  const rows = await prisma.qmsInspection.findMany({
    where: { id: { startsWith: P }, isDeleted: false },
    orderBy: { submittedAt: 'desc' },
    take: 50,
  })
  const events = await prisma.flowEvent.findMany({ where: { qmsInspectionId: { in: rows.map((r) => r.id) } }, select: { qmsInspectionId: true } })
  const matched = new Set(events.map((e) => e.qmsInspectionId))
  return rows.map((r) => ({
    id: r.id,
    requestNo: r.requestNo,
    workOrderNumber: r.workOrderNumber,
    partName: r.partName,
    processName: r.processName,
    supplierName: r.supplierName,
    quantity: r.quantity,
    status: r.status,
    inspectionResult: r.inspectionResult,
    unqualifiedQuantity: r.unqualifiedQuantity,
    linkedIssueNo: r.linkedIssueNo,
    matched: matched.has(r.id),
  }))
}

/**
 * 模拟 QMS 检验结论（按 QMS 实际行为）：判不合格时写 inspectionResult=FAIL、不合格数量，并关联一张 QMS 问题单
 * （linkedIssueNo），status 保持 INSPECTING、closedAt 为空；然后立即跑一轮 QMS 不合格转异常。
 * 只能改 DEMO- 开头的报检（真实数据只允许同步任务写）。
 */
export async function failDemoInspection(id: string, unqualifiedQuantity: number) {
  if (!id.startsWith(P)) throw new FlowError('只能修改演示报检')
  const ins = await prisma.qmsInspection.findUnique({ where: { id } })
  if (!ins) throw new FlowError('报检不存在')
  if (unqualifiedQuantity > ins.quantity) throw new FlowError('不合格数量不能大于报检数量')
  const now = new Date()
  await prisma.qmsInspection.update({
    where: { id },
    data: {
      status: 'INSPECTING',
      inspectionResult: 'FAIL',
      unqualifiedQuantity,
      linkedIssueId: ins.linkedIssueId ?? `${P}QI-${now.getTime()}`,
      linkedIssueNo: ins.linkedIssueNo ?? `${P}QI-${now.getTime()}`,
      closedAt: null,
      updatedAt: now,
    },
  })
  return { inspectionId: id, nonconforming: await syncNonconforming() }
}
