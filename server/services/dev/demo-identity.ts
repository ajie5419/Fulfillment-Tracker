import type { Prisma } from '@prisma/client'
import { BUSINESS_DEPT_NAME } from '../../../shared/business-depts'

const P = 'DEMO-'

// 异常分类的默认责任部门按名称匹配这些部门（方案 6.4）
export const DEPARTMENTS = [
  { id: `${P}DEPT-TECH`, name: BUSINESS_DEPT_NAME.TECH },
  { id: `${P}DEPT-PROC`, name: BUSINESS_DEPT_NAME.PROCESS },
  { id: `${P}DEPT-PUR`, name: BUSINESS_DEPT_NAME.PURCHASE },
  { id: `${P}DEPT-FIN`, name: BUSINESS_DEPT_NAME.FINANCE },
  { id: `${P}DEPT-QA`, name: BUSINESS_DEPT_NAME.QUALITY },
  { id: `${P}DEPT-PROD`, name: BUSINESS_DEPT_NAME.PRODUCTION },
  { id: `${P}DEPT-PROJ`, name: BUSINESS_DEPT_NAME.PROJECT },
  { id: `${P}DEPT-LEAD`, name: '公司领导' },
  // R13：班组、科室挂在大部门下面（部门对照只对到大部门，下级自动继承）；行政部不对应任何业务部门（算"其他"）
  { id: `${P}DEPT-WELD`, name: '组焊班', parentId: `${P}DEPT-PROD` },
  { id: `${P}DEPT-QC`, name: '检验科', parentId: `${P}DEPT-QA` },
  { id: `${P}DEPT-ADMIN`, name: '行政部' },
  // 生产管理重设计第二批：班组长演示。装配班不对应业务部门（算"其他"），只凭"班组长"身份登记本班组自制工序
  { id: `${P}DEPT-ASSY`, name: '装配班' },
]

/** R13 部门对照：大部门对到业务部门（演示各部门视角；班组、科室不单独对照，沿上级继承） */
export const DEPT_MAPPINGS = [
  { qmsDepartmentId: `${P}DEPT-TECH`, businessDept: 'TECH' },
  { qmsDepartmentId: `${P}DEPT-PROC`, businessDept: 'PROCESS' },
  { qmsDepartmentId: `${P}DEPT-PUR`, businessDept: 'PURCHASE' },
  { qmsDepartmentId: `${P}DEPT-FIN`, businessDept: 'FINANCE' },
  { qmsDepartmentId: `${P}DEPT-QA`, businessDept: 'QUALITY' },
  { qmsDepartmentId: `${P}DEPT-PROD`, businessDept: 'PRODUCTION' },
  { qmsDepartmentId: `${P}DEPT-PROJ`, businessDept: 'PROJECT' },
] as const

// 模拟身份桥按这些 ID 登录（授权页可选 u-001 ~ u-006），所以 ID 不带前缀。QMS 用户的部门存部门 ID
export const USERS = [
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
  // R11：技术部负责人（设计任务没指定设计负责人时的责任人；W7 黄色起收到）
  { id: 'u-011', username: `${P}u-011`, realName: '测试技术负责人', departmentId: `${P}DEPT-TECH`, roleId: `${P}ROLE-TECH-HEAD`, roleName: '部门负责人' },
  // R13 各部门视角：组焊班（经部门对照算生产部）、检验科（算质量部）、行政部（其他部门，只看"每日"）
  { id: 'u-012', username: `${P}u-012`, realName: '测试焊工', departmentId: `${P}DEPT-WELD`, roleId: `${P}ROLE-WORKER`, roleName: '操作工' },
  { id: 'u-013', username: `${P}u-013`, realName: '测试检验员', departmentId: `${P}DEPT-QC`, roleId: `${P}ROLE-QC`, roleName: '检验员' },
  { id: 'u-014', username: `${P}u-014`, realName: '测试行政', departmentId: `${P}DEPT-ADMIN`, roleId: `${P}ROLE-ADMIN`, roleName: '行政' },
  // 工艺部（10-24）：分解料单、编制下发工艺文件、定工艺路线
  { id: 'u-015', username: `${P}u-015`, realName: '测试工艺员', departmentId: `${P}DEPT-PROC`, roleId: `${P}ROLE-PROCESS`, roleName: '工艺员' },
  // 生产管理重设计第二批：班组长（装配一班），没有别的角色——只能登记本班组自制工序的开工、完工、报工，其余只读
  { id: 'u-016', username: `${P}u-016`, realName: '测试班组长', departmentId: `${P}DEPT-ASSY`, roleId: `${P}ROLE-TEAM-LEADER`, roleName: '班组长' },
]

// 预警升级阶梯的通知对象（方案 6.2）
export const NOTIFY_ROLES = [
  { id: `${P}ROLE-1`, role: 'OUTSOURCE_COORDINATOR', userId: 'u-001', department: null },
  { id: `${P}ROLE-2`, role: 'DEPT_HEAD', userId: 'u-002', department: 'PRODUCTION' },
  { id: `${P}ROLE-3`, role: 'PROJECT_DEPT_HEAD', userId: 'u-004', department: null },
  { id: `${P}ROLE-4`, role: 'LEADER', userId: 'u-005', department: null },
  { id: `${P}ROLE-5`, role: 'DEPT_HEAD', userId: 'u-006', department: 'QUALITY' },
  { id: `${P}ROLE-6`, role: 'DEPT_HEAD', userId: 'u-009', department: 'PURCHASE' },
  { id: `${P}ROLE-7`, role: 'FINANCE', userId: 'u-010', department: null },
  { id: `${P}ROLE-8`, role: 'DEPT_HEAD', userId: 'u-011', department: 'TECH' },
  // 工艺模块（10-27）：设计变更涉及已下发的料单时提醒工艺部负责人
  { id: `${P}ROLE-9`, role: 'DEPT_HEAD', userId: 'u-015', department: 'PROCESS' },
] as const

/** Restore only missing fixture identities; preserve administrator edits. */
export async function ensureDemoIdentity(tx: Prisma.TransactionClient, now = new Date(), skipUsers = false) {
  for (const d of DEPARTMENTS) {
    await tx.qmsDepartment.upsert({ where: { id: d.id }, update: {}, create: { parentId: '0', ...d, status: 1, updatedAt: now } })
  }
  for (const m of DEPT_MAPPINGS) {
    await tx.deptMapping.upsert({ where: { qmsDepartmentId: m.qmsDepartmentId }, update: {}, create: m })
  }
  for (const u of skipUsers ? [] : USERS) {
    await tx.qmsUser.upsert({ where: { id: u.id }, update: {}, create: { ...u, status: 'ACTIVE', updatedAt: now } })
  }
  for (const r of NOTIFY_ROLES) {
    await tx.notifyRole.upsert({ where: { id: r.id }, update: {}, create: r })
  }
}
