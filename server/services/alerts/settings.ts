/** 设置页（仅管理员）：阈值、停工日、人员与角色（通知对象）、工单项目经理、部门对照（R13）。 */
import type { BusinessDept, NotifyRoleKind } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { recordAudit } from '../audit/record'
import { BUSINESS_DEPTS, BUSINESS_DEPT_NAME, BUSINESS_DEPT_NAMES, MAX_DEPT_DEPTH, resolveBusinessDept } from '../auth/departments'
import { FlowError } from '../flow/errors'
import { loadNames } from '../flow/names'
import { type RuleThreshold, type ScanRule, dateFieldDay } from './rules'
import { SCAN_RULES, loadThresholds } from './scan'
import { ACTIVE_WO_WHERE } from '../workorder/active'
import { departmentLabel, isBusinessDeptCode } from '../../../shared/business-depts'
import { alertReminderUnit, alertThresholdError } from '../../../shared/alert-policy'

export async function getSettings() {
  const [thresholds, offDays, roles, workOrders, exts, depts] = await Promise.all([
    loadThresholds(),
    prisma.offDay.findMany({ orderBy: { date: 'asc' } }),
    prisma.notifyRole.findMany({ orderBy: [{ role: 'asc' }, { department: 'asc' }] }),
    // 只列在做的工单（已完工 / 已取消的不用再指定项目经理）
    prisma.qmsWorkOrder.findMany({
      where: ACTIVE_WO_WHERE,
      orderBy: [{ deliveryDate: 'asc' }, { workOrderNumber: 'asc' }],
      select: { workOrderNumber: true, projectName: true, customerName: true },
    }),
    prisma.workOrderExt.findMany(),
    prisma.qmsDepartment.findMany({ where: { isDeleted: false }, orderBy: [{ name: 'asc' }, { id: 'asc' }], select: { id: true, name: true, parentId: true } }),
  ])
  const mapping = new Map((await prisma.deptMapping.findMany()).map((m) => [m.qmsDepartmentId, m.businessDept]))
  const names = await loadNames({ user: [...roles.map((r) => r.userId), ...exts.map((e) => e.projectManagerId)] })
  const pm = new Map(exts.map((e) => [e.workOrderNumber, e.projectManagerId]))
  return {
    thresholds: SCAN_RULES.map((rule) => ({ rule, ...thresholds[rule] })),
    offDays: offDays.map((d) => dateFieldDay(d.date)),
    // 部门负责人的部门只能选 7 个业务部门（用户的 QMS 部门经"部门对照"换成业务部门后对应）；
    // 已配置但不在这 7 个里的旧值也列出（标为旧值），免得看不到、删不掉
    departments: BUSINESS_DEPTS,
    legacyDepartments: [...new Set(roles.map((r) => r.department).filter((x): x is string => !!x && !isBusinessDeptCode(x)))].sort(),
    /** 还没有负责人的业务部门（预警升级、异常默认责任人会找不到人） */
    deptsWithoutHead: BUSINESS_DEPTS.filter((code) => !roles.some((r) => r.role === 'DEPT_HEAD' && r.department === code)).map(departmentLabel),
    businessDepts: BUSINESS_DEPTS.map((value) => ({ value, label: BUSINESS_DEPT_NAME[value] })),
    qmsDepartments: deptRows(depts, mapping),
    roles: roles.map((r) => ({ ...r, userName: names.user.get(r.userId) ?? r.userId })),
    workOrders: workOrders.map((w) => {
      const id = pm.get(w.workOrderNumber) ?? null
      return { ...w, projectManagerId: id, projectManagerName: id ? (names.user.get(id) ?? id) : null }
    }),
  }
}

export async function saveThreshold(rule: ScanRule, t: RuleThreshold) {
  const error = alertThresholdError(rule, t)
  if (error) throw new FlowError(error)
  const data = { remindHours: alertReminderUnit(rule) === null ? null : t.remindHours, yellowDays: t.yellowDays, redDays: t.redDays }
  return prisma.$transaction(async tx => {
    const result = await tx.threshold.upsert({ where: { rule }, update: data, create: { rule, ...data } })
    await recordAudit(tx, { action: 'settings.threshold', entityType: 'Threshold', entityId: rule, metadata: data })
    return result
  })
}

export async function addOffDay(date: Date) {
  await prisma.$transaction(async tx => {
    await tx.offDay.upsert({ where: { date }, update: {}, create: { date } })
    await recordAudit(tx, { action: 'settings.offday.add', entityType: 'OffDay', entityId: date.toISOString() })
  })
  return { ok: true }
}

export async function removeOffDay(date: Date) {
  await prisma.$transaction(async tx => {
    const result = await tx.offDay.deleteMany({ where: { date } })
    if (result.count) await recordAudit(tx, { action: 'settings.offday.remove', entityType: 'OffDay', entityId: date.toISOString() })
  })
  return { ok: true }
}

export async function addNotifyRole(input: { role: NotifyRoleKind; userId: string; department?: string | null }) {
  const department = input.role === 'DEPT_HEAD' ? input.department?.trim() || null : null
  if (input.role === 'DEPT_HEAD' && !department) throw new FlowError('部门负责人要选择部门')
  if (department && !isBusinessDeptCode(department)) throw new FlowError(`部门只能选：${BUSINESS_DEPT_NAMES.join('、')}`)
  const user = await prisma.qmsUser.findFirst({ where: { id: input.userId, isDeleted: false }, select: { id: true } })
  if (!user) throw new FlowError('用户不存在')
  const exists = await prisma.notifyRole.findFirst({ where: { role: input.role, userId: input.userId, department } })
  if (exists) return exists
  return prisma.$transaction(async tx => {
    const result = await tx.notifyRole.create({ data: { role: input.role, userId: input.userId, department } })
    await recordAudit(tx, { action: 'settings.role.add', entityType: 'NotifyRole', entityId: result.id, metadata: { role: input.role, userId: input.userId, department } })
    return result
  })
}

export async function removeNotifyRole(id: string) {
  await prisma.$transaction(async tx => {
    const existing = await tx.notifyRole.findUnique({ where: { id } })
    const result = await tx.notifyRole.deleteMany({ where: { id } })
    if (result.count && existing) await recordAudit(tx, { action: 'settings.role.remove', entityType: 'NotifyRole', entityId: id, metadata: { role: existing.role, userId: existing.userId, department: existing.department } })
  })
  return { ok: true }
}

export async function setProjectManager(workOrderNumber: string, projectManagerId: string | null) {
  const wo = await prisma.qmsWorkOrder.findUnique({ where: { workOrderNumber }, select: { workOrderNumber: true } })
  if (!wo) throw new FlowError('工单不存在')
  if (projectManagerId) {
    const user = await prisma.qmsUser.findFirst({ where: { id: projectManagerId, isDeleted: false }, select: { id: true } })
    if (!user) throw new FlowError('用户不存在')
  }
  return prisma.$transaction(async tx => {
    const result = await tx.workOrderExt.upsert({ where: { workOrderNumber }, update: { projectManagerId }, create: { workOrderNumber, projectManagerId } })
    await recordAudit(tx, { action: 'settings.project-manager', entityType: 'WorkOrder', entityId: workOrderNumber, metadata: { projectManagerId } })
    return result
  })
}

// ───────────── 部门对照（R13）─────────────

interface DeptRow {
  id: string
  name: string
  parentId: string
}

/**
 * 部门对照表的行：已同步的 QMS 部门按层级排（上级在前，下级缩进），带上级名称、本行对照、
 * 以及没有对照时实际生效的业务部门（继承自上级，或部门名称正好是业务部门名）。
 */
export function deptRows(depts: DeptRow[], mapping: Map<string, BusinessDept>) {
  const byId = new Map(depts.map((d) => [d.id, d]))
  const index = { depts: byId, mapping }
  const children = new Map<string, DeptRow[]>()
  const roots: DeptRow[] = []
  for (const d of depts) {
    if (d.parentId && byId.has(d.parentId) && d.parentId !== d.id) children.set(d.parentId, [...(children.get(d.parentId) ?? []), d])
    else roots.push(d)
  }
  const out: { id: string; name: string; parentName: string | null; level: number; businessDept: BusinessDept | null; effective: string | null }[] = []
  const seen = new Set<string>()
  const walk = (d: DeptRow, level: number) => {
    if (seen.has(d.id) || level > MAX_DEPT_DEPTH) return
    seen.add(d.id)
    const own = mapping.get(d.id) ?? null
    const identity = resolveBusinessDept(d.id, index)
    const effective = identity ? BUSINESS_DEPT_NAME[identity] : null
    out.push({ id: d.id, name: d.name, parentName: byId.get(d.parentId)?.name ?? null, level, businessDept: own, effective })
    for (const c of children.get(d.id) ?? []) walk(c, level + 1)
  }
  for (const r of roots) walk(r, 0)
  // 成环的部门（数据异常）不在任何根下面，单独列在最后
  for (const d of depts) if (!seen.has(d.id)) walk(d, 0)
  return out
}

/** 保存一个 QMS 部门的对照：businessDept 为 null 表示"不对应"（删除对照） */
export async function setDeptMapping(qmsDepartmentId: string, businessDept: BusinessDept | null) {
  const dept = await prisma.qmsDepartment.findUnique({ where: { id: qmsDepartmentId }, select: { id: true } })
  if (!dept) throw new FlowError('部门不存在，请先同步 QMS')
  if (!businessDept) {
    await prisma.$transaction(async tx => {
      await tx.deptMapping.deleteMany({ where: { qmsDepartmentId } })
      await recordAudit(tx, { action: 'settings.department', entityType: 'DeptMapping', entityId: qmsDepartmentId, metadata: { businessDept: null } })
    })
    return { ok: true, businessDept: null }
  }
  await prisma.$transaction(async tx => {
    await tx.deptMapping.upsert({ where: { qmsDepartmentId }, update: { businessDept }, create: { qmsDepartmentId, businessDept } })
    await recordAudit(tx, { action: 'settings.department', entityType: 'DeptMapping', entityId: qmsDepartmentId, metadata: { businessDept } })
  })
  return { ok: true, businessDept }
}
