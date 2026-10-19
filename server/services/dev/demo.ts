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
import { todayDate } from '../purchases/constants'
import { createRelease } from '../releases/releases'
import { matchIncomingInspections } from '../purchases/incoming'
import type { QmsBomItem } from '../bom/client'
import { CONFIRM_PLAN_NODE, PLAN_REF, planLink } from '../plan/constants'
import { deptHeads } from '../plan/plan'

const P = 'DEMO-'
const DAY = 86_400_000

/**
 * 演示数据里的日期一律在 seedDemo 执行时按上海日历现算（相对"工厂时区今天"偏移 offset 天，存当天 UTC 零点）。
 * 不在模块加载时算、也不按 UTC 日期算：上海时间 0–8 点 UTC 还是前一天，会差一天（如出图任务从黄变红、需求日提前一天）。
 */
const dayFn = (now: Date) => {
  const today = todayDate(now).getTime()
  return (offset: number) => new Date(today + offset * DAY)
}

const workOrders = (day: (offset: number) => Date) => [
  { workOrderNumber: `${P}WO-001`, customerName: '演示客户（铁路局）', projectName: '高铁架桥机（演示）', division: '桥机事业部', quantity: 1, deliveryDate: day(35) },
  { workOrderNumber: `${P}WO-002`, customerName: '演示客户（风电）', projectName: '风电叶片模具（演示）', division: '模具事业部', quantity: 2, deliveryDate: day(60) },
  // 没有设项目经理：演示"项目经理只看到自己负责的工单"（u-003 看不到这一单）
  { workOrderNumber: `${P}WO-003`, customerName: '演示客户（港口）', projectName: '港口门机（演示）', division: '起重事业部', quantity: 1, deliveryDate: day(90) },
]
const WORK_ORDER_NUMBERS = [`${P}WO-001`, `${P}WO-002`, `${P}WO-003`]
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
  // R13：班组、科室挂在大部门下面（部门对照只对到大部门，下级自动继承）；行政部不对应任何业务部门（算"其他"）
  { id: `${P}DEPT-WELD`, name: '组焊班', parentId: `${P}DEPT-PROD` },
  { id: `${P}DEPT-QC`, name: '检验科', parentId: `${P}DEPT-QA` },
  { id: `${P}DEPT-ADMIN`, name: '行政部' },
]

/** R13 部门对照：大部门对到业务部门（演示各部门视角；班组、科室不单独对照，沿上级继承） */
const DEPT_MAPPINGS = [
  { qmsDepartmentId: `${P}DEPT-TECH`, businessDept: 'TECH' },
  { qmsDepartmentId: `${P}DEPT-PUR`, businessDept: 'PURCHASE' },
  { qmsDepartmentId: `${P}DEPT-FIN`, businessDept: 'FINANCE' },
  { qmsDepartmentId: `${P}DEPT-QA`, businessDept: 'QUALITY' },
  { qmsDepartmentId: `${P}DEPT-PROD`, businessDept: 'PRODUCTION' },
  { qmsDepartmentId: `${P}DEPT-PROJ`, businessDept: 'PROJECT' },
] as const

const SUPPLIERS = [
  { id: `${P}SUP-01`, name: '厂内组焊队', outsourcingMode: 'IN_PLANT', kind: 'TEAM' }, // 厂内外协班组
  { id: `${P}SUP-02`, name: '厂外组焊厂', outsourcingMode: 'EXTERNAL' },
  { id: `${P}SUP-03`, name: '机加厂', outsourcingMode: 'EXTERNAL' },
  { id: `${P}SUP-04`, name: '涂装厂', outsourcingMode: 'EXTERNAL' },
  { id: `${P}SUP-05`, name: '热处理厂', outsourcingMode: 'EXTERNAL' },
  // R10 关键物料供应商
  { id: `${P}SUP-06`, name: '演示轴承厂', outsourcingMode: null },
  { id: `${P}SUP-07`, name: '演示液压件公司', outsourcingMode: null },
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
  // R9 发放签收的发放人
  { id: 'u-008', username: `${P}u-008`, realName: '测试设计员', departmentId: `${P}DEPT-TECH`, roleId: `${P}ROLE-DESIGN`, roleName: '设计人员' },
  // R10：采购部负责人兼采购员；财务
  { id: 'u-009', username: `${P}u-009`, realName: '测试采购员', departmentId: `${P}DEPT-PUR`, roleId: `${P}ROLE-BUYER`, roleName: '采购员' },
  { id: 'u-010', username: `${P}u-010`, realName: '测试财务', departmentId: `${P}DEPT-FIN`, roleId: `${P}ROLE-FIN`, roleName: '财务' },
  // R11：技术部负责人（出图任务没指定设计负责人时的责任人；W7 黄色起收到）
  { id: 'u-011', username: `${P}u-011`, realName: '测试技术负责人', departmentId: `${P}DEPT-TECH`, roleId: `${P}ROLE-TECH-HEAD`, roleName: '部门负责人' },
  // R13 各部门视角：组焊班（经部门对照算生产部）、检验科（算质量部）、行政部（其他部门，只看"每日"）
  { id: 'u-012', username: `${P}u-012`, realName: '测试焊工', departmentId: `${P}DEPT-WELD`, roleId: `${P}ROLE-WORKER`, roleName: '操作工' },
  { id: 'u-013', username: `${P}u-013`, realName: '测试检验员', departmentId: `${P}DEPT-QC`, roleId: `${P}ROLE-QC`, roleName: '检验员' },
  { id: 'u-014', username: `${P}u-014`, realName: '测试行政', departmentId: `${P}DEPT-ADMIN`, roleId: `${P}ROLE-ADMIN`, roleName: '行政' },
]

// 预警升级阶梯的通知对象（方案 6.2）
const NOTIFY_ROLES = [
  { id: `${P}ROLE-1`, role: 'OUTSOURCE_COORDINATOR', userId: 'u-001', department: null },
  { id: `${P}ROLE-2`, role: 'DEPT_HEAD', userId: 'u-002', department: '生产部' },
  { id: `${P}ROLE-3`, role: 'PROJECT_DEPT_HEAD', userId: 'u-004', department: null },
  { id: `${P}ROLE-4`, role: 'LEADER', userId: 'u-005', department: null },
  { id: `${P}ROLE-5`, role: 'DEPT_HEAD', userId: 'u-006', department: '质量部' },
  { id: `${P}ROLE-6`, role: 'DEPT_HEAD', userId: 'u-009', department: '采购部' },
  { id: `${P}ROLE-7`, role: 'FINANCE', userId: 'u-010', department: null },
  { id: `${P}ROLE-8`, role: 'DEPT_HEAD', userId: 'u-011', department: '技术部' },
] as const

const PART_ID = `${P}PART-001`
const STEPS = [
  { id: `${P}STEP-001`, seq: 1, processId: `${P}PRC-WELD`, mode: 'EXTERNAL_OUTSOURCE', supplierId: `${P}SUP-02`, ownerId: 'u-001' },
  { id: `${P}STEP-002`, seq: 2, processId: `${P}PRC-PAINT`, mode: 'EXTERNAL_OUTSOURCE', supplierId: `${P}SUP-04`, ownerId: 'u-001' },
  { id: `${P}STEP-003`, seq: 3, processId: `${P}PRC-ASSY`, mode: 'SELF', supplierId: null, ownerId: 'u-002' },
] as const

/**
 * R9 演示：第二个工件"支腿"，下料（自制）已在加工、机加（厂外）还没开工。
 * 演示设计变更：已在加工 → 生产经理、外协专员收到"确认变更影响"；机加标"等变更"。
 * 不用主梁结构件：它是 Q12 演示（返厂后 W2 计时）的主角，标了等变更 W2 就不计时了。
 */
const PART2_ID = `${P}PART-002`
const STEPS2 = [
  { id: `${P}STEP-201`, seq: 1, processId: `${P}PRC-CUT`, mode: 'SELF', supplierId: null, ownerId: 'u-002', status: 'IN_PROGRESS' },
  { id: `${P}STEP-202`, seq: 2, processId: `${P}PRC-MACH`, mode: 'EXTERNAL_OUTSOURCE', supplierId: `${P}SUP-03`, ownerId: 'u-001', status: 'PENDING' },
] as const

/**
 * R10 演示关键物料（需求日、承诺日相对今天）：
 *   钢板：承诺日、需求日都过了还没到，卡交期预付款待付、原因"付款" → W6 红；
 *   液压马达：5 天后要用还没有承诺日 → W6 黄（没指定采购负责人 → 采购部负责人）；
 *   回转支承：等到货，演示工具"模拟进货检验"可自动确认到货；
 *   减速机：晚到了 2 天，原因"供应商"；加热管：按时到了。
 * 主梁结构件挂了钢板、回转支承、减速机：钢板和回转支承都到了以后，第一道（组焊，外协专员）收到"可以开工"。
 * 登记时间放在 20 天前：今天模拟的进货检验在登记之后，能自动对上。
 */
const purchaseLines = (day: (offset: number) => Date) => [
  { id: `${P}PL-001`, workOrderNumber: `${P}WO-001`, partId: PART_ID, materialName: 'Q355B 钢板', spec: 'δ=20', quantity: 30, unit: 't', supplierId: null, supplierName: '演示钢厂（手填）', needDate: day(-2), promisedDate: day(-5), buyerId: 'u-009', delayReason: 'PAYMENT', delayNote: '预付款未付，钢厂不排产', arrivedDate: null },
  { id: `${P}PL-002`, workOrderNumber: `${P}WO-001`, partId: PART2_ID, materialName: '进口液压马达', spec: 'A2FM 63', quantity: 2, unit: '台', supplierId: `${P}SUP-07`, supplierName: '演示液压件公司', needDate: day(5), promisedDate: null, buyerId: null, delayReason: null, delayNote: null, arrivedDate: null },
  { id: `${P}PL-003`, workOrderNumber: `${P}WO-001`, partId: PART_ID, materialName: '回转支承', spec: '013.45.1250', quantity: 1, unit: '套', supplierId: `${P}SUP-06`, supplierName: '演示轴承厂', needDate: day(12), promisedDate: day(8), buyerId: 'u-009', delayReason: null, delayNote: null, arrivedDate: null },
  { id: `${P}PL-004`, workOrderNumber: `${P}WO-001`, partId: PART_ID, materialName: '减速机', spec: 'ZQ-650', quantity: 2, unit: '台', supplierId: null, supplierName: '演示减速机厂（手填）', needDate: day(-6), promisedDate: day(-8), buyerId: 'u-009', delayReason: 'SUPPLIER', delayNote: '供应商排产推迟', arrivedDate: day(-4) },
  { id: `${P}PL-005`, workOrderNumber: `${P}WO-002`, partId: null, materialName: '模具加热管', spec: 'Φ16×1200', quantity: 40, unit: '支', supplierId: null, supplierName: '演示电热元件厂（手填）', needDate: day(10), promisedDate: day(6), buyerId: 'u-009', delayReason: null, delayNote: null, arrivedDate: day(-1) },
] as const

const payments = (day: (offset: number) => Date) => [
  { id: `${P}PAY-001`, workOrderNumber: `${P}WO-001`, amount: 186000, requestDate: day(-10), blocksDelivery: true, status: 'PENDING', note: '钢板预付款 30%，不付不排产', financeNote: null, lines: [`${P}PL-001`] },
  { id: `${P}PAY-002`, workOrderNumber: `${P}WO-001`, amount: 52000, requestDate: day(-3), blocksDelivery: false, status: 'ON_HOLD', note: '回转支承到货款', financeNote: '月底统一付', lines: [`${P}PL-003`] },
  { id: `${P}PAY-003`, workOrderNumber: `${P}WO-002`, amount: 8000, requestDate: day(-12), blocksDelivery: false, status: 'PAID', note: '加热管全款', financeNote: null, lines: [`${P}PL-005`] },
] as const

/**
 * R11 演示出图任务（设计负责人 u-008 测试设计员；技术部负责人 u-011）：
 *   主梁结构件总图：计划完成日已过 2 天还没出图 → W7 红；它挡着主梁结构件的"可以开工"（物料齐了也不发），
 *     标记出图 → 一键发放后才发；
 *   支腿零件图：明天到计划完成日 → W7 黄；
 *   液压系统原理图（不关联工件）：6 天前已出图、需要客户确认，客户确认计划日已过 3 天 → W7 黄（再过 1 天红），还没发放；
 *   模具加热系统布置图（DEMO-WO-002，负责人 u-011）：8 天后到期，不预警。
 */
const drawingTasks = (day: (offset: number) => Date) => {
  return [
    { id: `${P}DT-001`, workOrderNumber: `${P}WO-001`, componentName: '主梁结构件总图', ownerId: 'u-008', planDate: day(-2), needsCustomerConfirm: false, customerPlanDate: null, drawnDate: null, status: 'PENDING', partIds: [PART_ID] },
    { id: `${P}DT-002`, workOrderNumber: `${P}WO-001`, componentName: '支腿零件图', ownerId: 'u-008', planDate: day(1), needsCustomerConfirm: false, customerPlanDate: null, drawnDate: null, status: 'PENDING', partIds: [PART2_ID] },
    { id: `${P}DT-003`, workOrderNumber: `${P}WO-001`, componentName: '液压系统原理图', ownerId: 'u-008', planDate: day(-8), needsCustomerConfirm: true, customerPlanDate: day(-3), drawnDate: day(-6), status: 'DRAWN', partIds: [] },
    { id: `${P}DT-004`, workOrderNumber: `${P}WO-002`, componentName: '模具加热系统布置图', ownerId: 'u-011', planDate: day(8), needsCustomerConfirm: true, customerPlanDate: day(15), drawnDate: null, status: 'PENDING', partIds: [] },
  ] as const
}

/**
 * R12 齐套演示：第三个工件"回转底座"（机加已完工），以及 DEMO-WO-001 的 3 个装配节点：
 *   回转机构部装（负责人 u-002）：回转底座（已完成）+ 减速机（已到货）→ 齐套 100%；
 *   主梁总装（不指定负责人 = 生产经理）：3 天后要装，主梁结构件（图纸未完成）+ 钢板（超承诺日）+ 回转支承（待到货）→ 0%，W8 黄；
 *   支腿部装（负责人 u-002）：20 天后，支腿（下料在制）+ 进口液压马达（无承诺日）→ 缺件，还没到预警窗口。
 */
const PART3_ID = `${P}PART-003`
const STEP3 = { id: `${P}STEP-301`, seq: 1, processId: `${P}PRC-MACH`, mode: 'SELF', supplierId: null, ownerId: 'u-002', status: 'DONE' } as const
const assemblyNodes = (day: (offset: number) => Date) => [
  { id: `${P}NODE-001`, workOrderNumber: `${P}WO-001`, name: '回转机构部装', needDate: day(10), ownerId: 'u-002', sortOrder: 1, note: '演示：齐套', partIds: [PART3_ID], purchaseIds: [`${P}PL-004`] },
  { id: `${P}NODE-002`, workOrderNumber: `${P}WO-001`, name: '主梁总装', needDate: day(3), ownerId: null, sortOrder: 2, note: '演示：临近需求日仍缺件 → W8 黄', partIds: [PART_ID], purchaseIds: [`${P}PL-001`, `${P}PL-003`] },
  { id: `${P}NODE-003`, workOrderNumber: `${P}WO-001`, name: '支腿部装', needDate: day(20), ownerId: 'u-002', sortOrder: 3, note: '演示：缺件，还没到预警窗口', partIds: [PART2_ID], purchaseIds: [`${P}PL-002`] },
]

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

/**
 * R14 总计划演示（DEMO-WO-001，交期 35 天后），已发布，挂上了上面的出图 / 采购 / 工序 / 装配记录：
 *   合同评审（项目部）：已手动完成；
 *   设计出图（技术部，计划昨天）：主梁总图逾期、液压原理图客户确认逾期（按今天算），支腿零件图计划明天（晚于节点日，标红）→ 自身晚 2 天，源头节点，W9 黄；
 *   关键物料到货（采购部，计划 4 天后）：回转支承承诺 8 天后到、液压马达需求 5 天后（都晚于节点日，标红）→ 自身晚 4 天，源头节点，W9 红；
 *   之后各节点按原间隔顺延 4 天 → 发运（= 交期）预计晚 4 天：这些节点标"受上游影响"、不单独报 W9；
 *   预计交期拖期 → 工单级 W9 红（交期风险，发给项目经理、项目部负责人、分管领导）；看板拖期 4 天、源头延误节点 2 个，领导总览"预计拖期工单"。
 *   部门确认：合同评审、设计出图已确认；机加被生产部退回（项目经理 u-003 收到提醒）；其余待确认（部门负责人"我的待办"里有确认待办）。
 *   调整记录：装配节点发布后改过一次日期（写了原因）。
 */
const PLAN_NODES = (day: (offset: number) => Date) => [
  { id: `${P}PN-01`, seq: 1, name: '合同评审', dept: 'PROJECT', planDate: day(-30), done: day(-31), confirm: 'CONFIRMED', by: 'u-004' },
  { id: `${P}PN-02`, seq: 2, name: '设计出图', dept: 'TECH', planDate: day(-1), confirm: 'CONFIRMED', by: 'u-011' },
  { id: `${P}PN-03`, seq: 3, name: '关键物料到货', dept: 'PURCHASE', planDate: day(4), confirm: 'PENDING' },
  { id: `${P}PN-04`, seq: 4, name: '组焊涂装', dept: 'PRODUCTION', planDate: day(14), confirm: 'PENDING' },
  { id: `${P}PN-05`, seq: 5, name: '机加', dept: 'PRODUCTION', planDate: day(18), confirm: 'REJECTED', by: 'u-002', reason: '外协机加厂排产已满，最早只能比计划晚一周' },
  { id: `${P}PN-06`, seq: 6, name: '装配', dept: 'PRODUCTION', planDate: day(25), baseline: day(23), confirm: 'PENDING' },
  { id: `${P}PN-07`, seq: 7, name: '调试', dept: 'TECH', planDate: day(31), confirm: 'PENDING' },
  { id: `${P}PN-08`, seq: 8, name: '发运', dept: 'PROJECT', planDate: day(35), confirm: 'PENDING' },
] as const
/** 部门记录挂哪个节点 */
const PLAN_LINKS = {
  drawing: { [`${P}PN-02`]: [`${P}DT-001`, `${P}DT-002`, `${P}DT-003`] },
  purchase: { [`${P}PN-03`]: [`${P}PL-001`, `${P}PL-002`, `${P}PL-003`, `${P}PL-004`] },
  step: { [`${P}PN-04`]: [`${P}STEP-001`, `${P}STEP-002`], [`${P}PN-05`]: [`${P}STEP-201`, `${P}STEP-202`, `${P}STEP-301`], [`${P}PN-06`]: [`${P}STEP-003`] },
  assembly: { [`${P}PN-06`]: [`${P}NODE-001`, `${P}NODE-002`, `${P}NODE-003`] },
} as const

/** R14：DEMO-WO-001 还没有总计划时写入（已发布，挂上演示记录）；有了就不动（不会把走到一半的演示打回原形） */
async function seedDemoPlan(day: (offset: number) => Date, now: Date) {
  const wo = `${P}WO-001`
  if (await prisma.workOrderPlan.findUnique({ where: { workOrderNumber: wo }, select: { workOrderNumber: true } })) return 0
  if (await prisma.planNode.findFirst({ where: { workOrderNumber: wo }, select: { id: true } })) return 0
  const nodes = PLAN_NODES(day)
  await prisma.$transaction(async (tx) => {
    await tx.workOrderPlan.create({ data: { workOrderNumber: wo, status: 'PUBLISHED', templateName: '通用', publishedAt: new Date(+now - 2 * DAY), publishedBy: 'u-003', createdBy: 'u-003' } })
    for (const n of nodes) {
      const done = 'done' in n ? n.done : null
      await tx.planNode.create({
        data: {
          id: n.id,
          workOrderNumber: wo,
          seq: n.seq,
          name: n.name,
          dept: n.dept,
          planDate: n.planDate,
          baselineDate: 'baseline' in n ? n.baseline : n.planDate,
          ...(done ? { actualDate: done, manualDoneBy: 'u-003', manualDoneAt: done } : {}),
          confirmStatus: n.confirm,
          ...('by' in n ? { confirmedBy: n.by, confirmedAt: new Date(+now - DAY) } : {}),
          rejectReason: 'reason' in n ? n.reason : null,
        },
      })
      // 待确认的节点：给责任部门负责人发确认待办（2 天前发的，扫描后 W9 未确认红）
      if (n.confirm === 'PENDING') {
        const owners = await deptHeads(tx, n.dept)
        if (owners.length) await tx.todo.createMany({ data: owners.map((ownerId) => ({ ownerId, action: CONFIRM_PLAN_NODE, refType: PLAN_REF, refId: n.id, createdAt: new Date(+now - 2 * DAY) })) })
      }
    }
    const assy = nodes.find((n) => n.id === `${P}PN-06`)!
    await tx.planChangeLog.create({
      data: { workOrderNumber: wo, nodeId: assy.id, nodeName: assy.name, kind: 'DATE', oldDate: day(23), newDate: assy.planDate, reason: '客户要求增加一项型式试验，装配顺延 2 天', actorId: 'u-003', createdAt: new Date(+now - DAY) },
    })
    for (const [nodeId, ids] of Object.entries(PLAN_LINKS.drawing)) await tx.drawingTask.updateMany({ where: { id: { in: [...ids] } }, data: { planNodeId: nodeId } })
    for (const [nodeId, ids] of Object.entries(PLAN_LINKS.purchase)) await tx.purchaseLine.updateMany({ where: { id: { in: [...ids] } }, data: { planNodeId: nodeId } })
    for (const [nodeId, ids] of Object.entries(PLAN_LINKS.step)) await tx.routeStep.updateMany({ where: { id: { in: [...ids] } }, data: { planNodeId: nodeId } })
    for (const [nodeId, ids] of Object.entries(PLAN_LINKS.assembly)) await tx.assemblyNode.updateMany({ where: { id: { in: [...ids] } }, data: { planNodeId: nodeId } })
    // 机加被退回：提醒项目经理
    const rejected = nodes.find((n) => n.confirm === 'REJECTED')!
    await tx.reminder.createMany({
      data: [{ userId: 'u-003', kind: 'PLAN', level: 'YELLOW', title: `【退回】测试生产经理（生产部）退回了总计划节点"${rejected.name}"：${'reason' in rejected ? rejected.reason : ''}（${wo}）`, link: planLink(wo, rejected.id), dedupeKey: `PLAN_REJECT:${rejected.id}:demo:u-003` }],
      skipDuplicates: true,
    })
  })
  return nodes.length
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
  const day = dayFn(now)
  await prisma.$transaction(async (tx) => {
    for (const wo of workOrders(day)) {
      await tx.qmsWorkOrder.upsert({ where: { workOrderNumber: wo.workOrderNumber }, update: {}, create: { ...wo, status: 'IN_PROGRESS', updatedAt: now } })
    }
    for (const s of SUPPLIERS) {
      await tx.qmsSupplier.upsert({ where: { id: s.id }, update: {}, create: { ...s, category: '外协', updatedAt: now } })
    }
    for (const p of PROCESSES) {
      await tx.qmsProcess.upsert({ where: { id: p.id }, update: {}, create: { ...p, supplierSource: 'Supplier', updatedAt: now } })
    }
    for (const d of DEPARTMENTS) {
      await tx.qmsDepartment.upsert({ where: { id: d.id }, update: {}, create: { parentId: '0', ...d, status: 1, updatedAt: now } })
    }
    // 部门对照：管理员在设置页改过的不覆盖
    for (const m of DEPT_MAPPINGS) {
      await tx.deptMapping.upsert({ where: { qmsDepartmentId: m.qmsDepartmentId }, update: {}, create: m })
    }
    for (const u of opts.skipUsers ? [] : USERS) {
      // 已有同 ID 的真实用户（同步来的）时不覆盖
      await tx.qmsUser.upsert({ where: { id: u.id }, update: {}, create: { ...u, status: 'ACTIVE', updatedAt: now } })
    }
    for (const r of NOTIFY_ROLES) {
      await tx.notifyRole.upsert({ where: { id: r.id }, update: {}, create: r })
    }
    // 演示工单 001、002 的项目经理是 u-003；003 不设项目经理
    for (const workOrderNumber of WORK_ORDER_NUMBERS) {
      const pm = PM_WORK_ORDERS.includes(workOrderNumber) ? 'u-003' : null
      await tx.workOrderExt.upsert({
        where: { workOrderNumber },
        update: {},
        create: { workOrderNumber, projectManagerId: pm, isPilot: true },
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
    await tx.part.upsert({
      where: { id: PART2_ID },
      update: {},
      create: { id: PART2_ID, workOrderNumber: `${P}WO-001`, name: '支腿', drawingNo: `${P}DWG-002`, quantity: 4, currentStepId: STEPS2[0].id },
    })
    for (const s of STEPS2) {
      await tx.routeStep.upsert({
        where: { id: s.id },
        update: {},
        create: { ...s, partId: PART2_ID, startedAt: s.status === 'IN_PROGRESS' ? now : null },
      })
    }
    // 模板按 ID 判断是否已有；同名的真实模板存在时不写（名称唯一）
    if (!(await tx.routeTemplate.findFirst({ where: { OR: [{ id: TEMPLATE.id }, { name: TEMPLATE.name }] }, select: { id: true } }))) {
      const { steps, ...t } = TEMPLATE
      await tx.routeTemplate.create({ data: { ...t, steps: { create: steps.map((x) => ({ ...x })) } } })
    }
    // R10 关键物料和付款申请（登记人 / 申请人 u-009；连着 QMS、没写演示用户时照样写，名字显示为 ID）
    const registeredAt = new Date(+now - 20 * DAY)
    for (const { arrivedDate, ...l } of purchaseLines(day)) {
      await tx.purchaseLine.upsert({
        where: { id: l.id },
        update: {},
        create: {
          ...l,
          createdBy: 'u-009',
          createdAt: registeredAt,
          ...(arrivedDate ? { status: 'ARRIVED', arrivedDate, arrivalSource: 'PC', arrivedBy: 'u-009', arrivedAt: arrivedDate } : {}),
        },
      })
    }
    for (const { lines, ...pay } of payments(day)) {
      if (await tx.paymentRequest.findUnique({ where: { id: pay.id }, select: { id: true } })) continue
      await tx.paymentRequest.create({
        data: { ...pay, requesterId: 'u-009', ...(pay.status === 'PAID' ? { statusBy: 'u-010', statusAt: now } : {}), lines: { create: lines.map((purchaseLineId) => ({ purchaseLineId })) } },
      })
    }
    // R11 出图任务（登记人 u-003）
    for (const { partIds, drawnDate, ...d } of drawingTasks(day)) {
      if (await tx.drawingTask.findUnique({ where: { id: d.id }, select: { id: true } })) continue
      await tx.drawingTask.create({
        data: { ...d, drawnDate, drawnBy: drawnDate ? d.ownerId : null, createdBy: 'u-003', parts: { create: partIds.map((partId) => ({ partId })) } },
      })
    }
    // R12：已完工的工件"回转底座"（机加完工，记一条完工事件）和 3 个装配节点
    await tx.part.upsert({
      where: { id: PART3_ID },
      update: {},
      create: { id: PART3_ID, workOrderNumber: `${P}WO-001`, name: '回转底座', drawingNo: `${P}DWG-003`, quantity: 1, currentStepId: STEP3.id, status: 'DONE' },
    })
    if (!(await tx.routeStep.findUnique({ where: { id: STEP3.id }, select: { id: true } }))) {
      const finishedAt = new Date(+now - 2 * DAY)
      await tx.routeStep.create({ data: { ...STEP3, partId: PART3_ID, startedAt: new Date(+finishedAt - 3 * DAY), finishedAt } })
      await tx.flowEvent.create({ data: { stepId: STEP3.id, type: 'FINISH', qty: 1, source: 'PC', actorId: 'u-002', occurredAt: finishedAt } })
    }
    for (const { partIds, purchaseIds, ...n } of assemblyNodes(day)) {
      if (await tx.assemblyNode.findUnique({ where: { id: n.id }, select: { id: true } })) continue
      await tx.assemblyNode.create({
        data: {
          ...n,
          createdBy: 'u-002',
          parts: { create: partIds.map((partId) => ({ partId })) },
          purchases: { create: purchaseIds.map((purchaseLineId) => ({ purchaseLineId })) },
        },
      })
    }
    // 第一道没有上一道触发待办，演示时直接给外协专员一条"安排发出"
    await tx.todo.upsert({
      where: { id: `${P}TODO-001` },
      update: {},
      create: { id: `${P}TODO-001`, ownerId: 'u-001', action: 'ARRANGE_SEND', refType: 'step', refId: `${P}STEP-001` },
    })
  })
  const releases = await seedDemoReleases()
  const planNodes = await seedDemoPlan(day, now)
  return {
    releases,
    planNodes,
    workOrders: WORK_ORDER_NUMBERS.length,
    suppliers: SUPPLIERS.length,
    processes: PROCESSES.length,
    departments: DEPARTMENTS.length,
    deptMappings: DEPT_MAPPINGS.length,
    users: opts.skipUsers ? 0 : USERS.length,
    notifyRoles: NOTIFY_ROLES.length,
    parts: 3,
    templates: 1,
    purchaseLines: purchaseLines(day).length,
    payments: payments(day).length,
    drawingTasks: drawingTasks(day).length,
    assemblyNodes: assemblyNodes(day).length,
  }
}

/**
 * R9 演示发放单（演示工单上还没有发放单时才写，走正式的 createRelease，编号、待办、等变更都和真实一样）：
 *   图纸：主梁结构件 A 版，发给生产部全部人员 + 项目经理 u-003 → 各自"我的待办"里有签收；
 *   设计变更：支腿孔位变更，发给外协专员、生产经理 → 下料在加工，生产经理和外协专员收到"确认变更影响"，机加标"等变更"。
 * 发放人 u-008（测试设计员）；连着 QMS 同步、没有写演示用户时用 u-003。
 */
async function seedDemoReleases() {
  // 两张各自判断，缺哪张补哪张（一张因演示用户不全没建成时，下次还能补上）
  const existing = new Set((await prisma.release.findMany({ where: { workOrderNumber: { startsWith: P } }, select: { type: true } })).map((r) => r.type))
  if (existing.has('DRAWING') && existing.has('CHANGE')) return 0
  const issuer = (await prisma.qmsUser.findFirst({ where: { id: 'u-008', isDeleted: false }, select: { id: true } })) ? 'u-008' : 'u-003'
  const recipients = await prisma.qmsUser.findMany({ where: { id: { in: ['u-001', 'u-002', 'u-003'] }, isDeleted: false, status: 'ACTIVE' }, select: { id: true } })
  if (!recipients.length) return 0
  const ids = recipients.map((u) => u.id)
  if (!existing.has('DRAWING')) {
    await createRelease(
      {
        type: 'DRAWING',
        workOrderNumber: `${P}WO-001`,
        partIds: [PART_ID],
        version: 'A',
        description: '主梁结构件总图及零件图（纸质 12 张），已随件发到车间',
        userIds: ids.filter((id) => id === 'u-003'),
        groups: ids.some((id) => id !== 'u-003') ? [{ department: '生产部', role: null }] : [],
      },
      issuer,
    ).catch(() => null) // 演示用户不全（连着 QMS）时跳过，不影响其余演示数据
  }
  if (!existing.has('CHANGE')) {
    await createRelease(
      {
        type: 'CHANGE',
        workOrderNumber: `${P}WO-001`,
        partIds: [PART2_ID],
        version: 'B',
        description: '支腿连接板安装孔由 Φ22 改为 Φ26，孔距不变；已下料的按新图扩孔',
        userIds: ids.filter((id) => id !== 'u-003'),
      },
      issuer,
    ).catch(() => null)
  }
  return prisma.release.count({ where: { workOrderNumber: { startsWith: P } } })
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
    // R9 演示发放单（签收记录随发放单级联删除）及其待办、W5 预警、拒收通知、附件
    const releaseRows = await tx.release.findMany({ where: { workOrderNumber: { startsWith: P } }, select: { id: true, receipts: { select: { id: true } } } })
    const releaseIds = releaseRows.map((r) => r.id)
    const receiptIds = releaseRows.flatMap((r) => r.receipts.map((x) => x.id))
    const todos = await tx.todo.deleteMany({
      where: {
        OR: [
          { id: { startsWith: P } },
          { refType: 'step', refId: { in: stepIds } },
          { refType: 'receipt', refId: { in: receiptIds } },
          { refType: 'release', refId: { in: releaseIds } },
        ],
      },
    })
    const issueRows = await tx.issue.findMany({ where: { workOrderNumber: { startsWith: P } }, select: { id: true } })
    const issueIds = issueRows.map((i) => i.id)
    // R10：演示工单上的付款申请（关联行级联删除）、采购行、进货检验处理记录、"可以开工"待办
    const purchaseIds = (await tx.purchaseLine.findMany({ where: { OR: [{ workOrderNumber: { startsWith: P } }, { partId: { in: partIds } }] }, select: { id: true } })).map((l) => l.id)
    const payments = await tx.paymentRequest.deleteMany({ where: { OR: [{ workOrderNumber: { startsWith: P } }, { lines: { some: { purchaseLineId: { in: purchaseIds } } } }] } })
    await tx.todo.deleteMany({ where: { refType: 'part', refId: { in: partIds } } })
    await tx.incomingCheck.deleteMany({ where: { OR: [{ qmsInspectionId: { in: insIds } }, { purchaseLineId: { in: purchaseIds } }] } })
    // R11：演示工单上的出图任务（关联工件随任务级联删除）
    const drawingIds = (await tx.drawingTask.findMany({ where: { OR: [{ workOrderNumber: { startsWith: P } }, { parts: { some: { partId: { in: partIds } } } }] }, select: { id: true } })).map((d) => d.id)
    // R12：演示工单上的装配节点（清单随节点级联删除）
    const nodeIds = (await tx.assemblyNode.findMany({ where: { workOrderNumber: { startsWith: P } }, select: { id: true } })).map((n) => n.id)
    // R14：演示工单的总计划（节点、发布状态、调整记录）及其确认待办、W9 预警、退回通知
    const planNodeIds = (await tx.planNode.findMany({ where: { workOrderNumber: { startsWith: P } }, select: { id: true } })).map((n) => n.id)
    await tx.todo.deleteMany({ where: { refType: PLAN_REF, refId: { in: planNodeIds } } })
    await tx.planChangeLog.deleteMany({ where: { workOrderNumber: { startsWith: P } } })
    await tx.reminder.deleteMany({ where: { kind: 'PLAN', link: { startsWith: '/plan?wo=DEMO-' } } })
    const alertRows = await tx.alert.findMany({
      where: {
        OR: [
          { refType: 'node', refId: { in: nodeIds } },
          { refType: { in: ['planNode', 'planConfirm'] }, refId: { in: planNodeIds } },
          { refType: 'plan', refId: { startsWith: P } },
          { refType: 'drawing', refId: { in: drawingIds } },
          { refType: 'purchase', refId: { in: purchaseIds } },
          { refType: 'step', refId: { in: stepIds } },
          { refType: 'unmatched', refId: { in: insIds } },
          { refType: 'issue', refId: { in: issueIds } },
          { refType: 'receipt', refId: { in: receiptIds } },
          { refType: 'release', refId: { in: releaseIds } },
        ],
      },
      select: { id: true },
    })
    const alertIds = alertRows.map((a) => a.id)
    const demoUsers = (await tx.qmsUser.findMany({ where: { username: { startsWith: P } }, select: { id: true } })).map((u) => u.id)
    const uploads = await tx.uploadFile.findMany({
      where: { OR: [{ issueId: { in: issueIds } }, { releaseId: { in: releaseIds } }, { uploaderId: { in: demoUsers }, issueId: null, releaseId: null }] },
      select: { id: true, storedName: true },
    })
    await tx.uploadFile.deleteMany({ where: { id: { in: uploads.map((u) => u.id) } } })
    const issues = await tx.issue.deleteMany({ where: { id: { in: issueIds } } }) // 处理日志级联删除
    const reminders = await tx.reminder.deleteMany({
      where: { OR: [{ alertId: { in: alertIds } }, { userId: { in: demoUsers } }, { dedupeKey: { in: receiptIds.map((id) => `RELEASE_REJECT:${id}`) } }] },
    })
    const releases = await tx.release.deleteMany({ where: { id: { in: releaseIds } } })
    const purchases = await tx.purchaseLine.deleteMany({ where: { id: { in: purchaseIds } } })
    const drawings = await tx.drawingTask.deleteMany({ where: { id: { in: drawingIds } } })
    const nodes = await tx.assemblyNode.deleteMany({ where: { id: { in: nodeIds } } })
    const planNodes = await tx.planNode.deleteMany({ where: { id: { in: planNodeIds } } })
    await tx.workOrderPlan.deleteMany({ where: { workOrderNumber: { startsWith: P } } })
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
    await tx.deptMapping.deleteMany({ where: { qmsDepartmentId: { startsWith: P } } })
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
      releases: releases.count,
      purchaseLines: purchases.count,
      payments: payments.count,
      drawingTasks: drawings.count,
      assemblyNodes: nodes.count,
      planNodes: planNodes.count,
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
  /** INCOMING = 进货检验（R10，确认采购行到货）；不填 = 外协返厂报检 */
  category?: 'INCOMING' | null
}

/** 模拟 QMS 新增一条返厂报检（或进货检验），然后立即跑一轮匹配 */
export async function createDemoInspection(input: DemoInspectionInput) {
  const [process, supplier] = await Promise.all([
    input.processId ? prisma.qmsProcess.findUnique({ where: { id: input.processId } }) : null,
    input.supplierId ? prisma.qmsSupplier.findUnique({ where: { id: input.supplierId } }) : null,
  ])
  const partName = input.partName?.trim() || ''
  const incoming = input.category === 'INCOMING'
  const processName = incoming ? '进货检验' : input.processName?.trim() || process?.name || ''
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
      processId: incoming ? null : input.processId || null,
      processName,
      category: incoming ? 'INCOMING' : null,
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
  const incomingResults = await matchIncomingInspections()
  const nonconforming = await syncNonconforming()
  return { inspectionId: id, result, incoming: incomingResults.find((r) => r.inspectionId === id) ?? null, processed: results.length + 1, nonconforming }
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
