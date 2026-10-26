/** 设置页（仅管理员）：阈值、停工日、人员与角色（通知对象）、工单项目经理、部门对照（R13）。 */
import type { BusinessDept, NotifyRoleKind } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { BUSINESS_DEPTS, BUSINESS_DEPT_NAME, BUSINESS_DEPT_NAMES, MAX_DEPT_DEPTH } from '../auth/departments'
import { FlowError } from '../flow/errors'
import { loadNames } from '../flow/names'
import { type RuleThreshold, type ScanRule, dateFieldDay } from './rules'
import { SCAN_RULES, loadThresholds } from './scan'
import { ACTIVE_WO_WHERE } from '../workorder/active'

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
    departments: BUSINESS_DEPT_NAMES,
    legacyDepartments: [...new Set(roles.map((r) => r.department).filter((x): x is string => !!x && !BUSINESS_DEPT_NAMES.includes(x)))].sort(),
    /** 还没有负责人的业务部门（预警升级、异常默认责任人会找不到人） */
    deptsWithoutHead: BUSINESS_DEPT_NAMES.filter((n) => !roles.some((r) => r.role === 'DEPT_HEAD' && r.department === n)),
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
  // W8 的黄 / 红是"需求日前几天"：越早越轻，所以黄色天数不能小于红色
  if (rule === 'W8') {
    if (t.yellowDays < t.redDays) throw new FlowError('W8 黄色的提前天数不能小于红色')
  } else if (t.redDays < t.yellowDays) throw new FlowError('红色阈值不能小于黄色阈值')
  const noRemind = rule === 'W2' || rule === 'W4' || rule === 'W8'
  if (!noRemind && t.remindHours == null) throw new FlowError('W1、W3、W5、W6、W7、W9、W10 必须设置提醒阈值')
  // W2、W4、W8 没有"提醒"一级；W9 的提醒是"总计划发布多久后节点仍未分解"
  const data = { remindHours: noRemind ? null : t.remindHours, yellowDays: t.yellowDays, redDays: t.redDays }
  return prisma.threshold.upsert({ where: { rule }, update: data, create: { rule, ...data } })
}

export async function addOffDay(date: Date) {
  await prisma.offDay.upsert({ where: { date }, update: {}, create: { date } })
  return { ok: true }
}

export async function removeOffDay(date: Date) {
  await prisma.offDay.deleteMany({ where: { date } })
  return { ok: true }
}

export async function addNotifyRole(input: { role: NotifyRoleKind; userId: string; department?: string | null }) {
  const department = input.role === 'DEPT_HEAD' ? input.department?.trim() || null : null
  if (input.role === 'DEPT_HEAD' && !department) throw new FlowError('部门负责人要选择部门')
  if (department && !BUSINESS_DEPT_NAMES.includes(department)) throw new FlowError(`部门只能选：${BUSINESS_DEPT_NAMES.join('、')}`)
  const user = await prisma.qmsUser.findFirst({ where: { id: input.userId, isDeleted: false }, select: { id: true } })
  if (!user) throw new FlowError('用户不存在')
  const exists = await prisma.notifyRole.findFirst({ where: { role: input.role, userId: input.userId, department } })
  if (exists) return exists
  return prisma.notifyRole.create({ data: { role: input.role, userId: input.userId, department } })
}

export async function removeNotifyRole(id: string) {
  await prisma.notifyRole.deleteMany({ where: { id } })
  return { ok: true }
}

export async function setProjectManager(workOrderNumber: string, projectManagerId: string | null) {
  const wo = await prisma.qmsWorkOrder.findUnique({ where: { workOrderNumber }, select: { workOrderNumber: true } })
  if (!wo) throw new FlowError('工单不存在')
  if (projectManagerId) {
    const user = await prisma.qmsUser.findFirst({ where: { id: projectManagerId, isDeleted: false }, select: { id: true } })
    if (!user) throw new FlowError('用户不存在')
  }
  return prisma.workOrderExt.upsert({ where: { workOrderNumber }, update: { projectManagerId }, create: { workOrderNumber, projectManagerId } })
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
  const children = new Map<string, DeptRow[]>()
  const roots: DeptRow[] = []
  for (const d of depts) {
    if (d.parentId && byId.has(d.parentId) && d.parentId !== d.id) children.set(d.parentId, [...(children.get(d.parentId) ?? []), d])
    else roots.push(d)
  }
  const out: { id: string; name: string; parentName: string | null; level: number; businessDept: BusinessDept | null; effective: string | null }[] = []
  const seen = new Set<string>()
  const walk = (d: DeptRow, level: number, inherited: BusinessDept | null) => {
    if (seen.has(d.id) || level > MAX_DEPT_DEPTH) return
    seen.add(d.id)
    const own = mapping.get(d.id) ?? null
    const eff = own ?? inherited
    const effective = eff ? BUSINESS_DEPT_NAME[eff] : BUSINESS_DEPT_NAMES.includes(d.name) ? d.name : null
    out.push({ id: d.id, name: d.name, parentName: byId.get(d.parentId)?.name ?? null, level, businessDept: own, effective })
    for (const c of children.get(d.id) ?? []) walk(c, level + 1, eff)
  }
  for (const r of roots) walk(r, 0, null)
  // 成环的部门（数据异常）不在任何根下面，单独列在最后
  for (const d of depts) if (!seen.has(d.id)) walk(d, 0, null)
  return out
}

/** 保存一个 QMS 部门的对照：businessDept 为 null 表示"不对应"（删除对照） */
export async function setDeptMapping(qmsDepartmentId: string, businessDept: BusinessDept | null) {
  const dept = await prisma.qmsDepartment.findUnique({ where: { id: qmsDepartmentId }, select: { id: true } })
  if (!dept) throw new FlowError('部门不存在，请先同步 QMS')
  if (!businessDept) {
    await prisma.deptMapping.deleteMany({ where: { qmsDepartmentId } })
    return { ok: true, businessDept: null }
  }
  await prisma.deptMapping.upsert({ where: { qmsDepartmentId }, update: { businessDept }, create: { qmsDepartmentId, businessDept } })
  return { ok: true, businessDept }
}
