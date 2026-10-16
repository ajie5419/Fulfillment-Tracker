/** 设置页（仅管理员）：阈值、停工日、通知对象、工单项目经理。 */
import type { NotifyRoleKind } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { FlowError } from '../flow/errors'
import { loadNames } from '../flow/names'
import { type RuleThreshold, type ScanRule, dateFieldDay } from './rules'
import { SCAN_RULES, loadThresholds } from './scan'

export async function getSettings() {
  const [thresholds, offDays, roles, workOrders, exts, depts, userDepts] = await Promise.all([
    loadThresholds(),
    prisma.offDay.findMany({ orderBy: { date: 'asc' } }),
    prisma.notifyRole.findMany({ orderBy: [{ role: 'asc' }, { department: 'asc' }] }),
    prisma.qmsWorkOrder.findMany({
      where: { isDeleted: false },
      orderBy: [{ deliveryDate: 'asc' }, { workOrderNumber: 'asc' }],
      select: { workOrderNumber: true, projectName: true, customerName: true },
    }),
    prisma.workOrderExt.findMany(),
    prisma.qmsDepartment.findMany({ where: { isDeleted: false }, select: { name: true } }),
    prisma.qmsUser.findMany({ where: { isDeleted: false }, distinct: ['department'], select: { department: true } }),
  ])
  const names = await loadNames({ user: [...roles.map((r) => r.userId), ...exts.map((e) => e.projectManagerId)] })
  const pm = new Map(exts.map((e) => [e.workOrderNumber, e.projectManagerId]))
  return {
    thresholds: SCAN_RULES.map((rule) => ({ rule, ...thresholds[rule] })),
    offDays: offDays.map((d) => dateFieldDay(d.date)),
    // 部门负责人按部门名称与 qms_user.department 对应，下拉给出已知的部门名
    departments: [...new Set([...depts.map((d) => d.name), ...userDepts.map((u) => u.department)].filter(Boolean))].sort(),
    roles: roles.map((r) => ({ ...r, userName: names.user.get(r.userId) ?? r.userId })),
    workOrders: workOrders.map((w) => {
      const id = pm.get(w.workOrderNumber) ?? null
      return { ...w, projectManagerId: id, projectManagerName: id ? (names.user.get(id) ?? id) : null }
    }),
  }
}

export async function saveThreshold(rule: ScanRule, t: RuleThreshold) {
  if (t.redDays < t.yellowDays) throw new FlowError('红色阈值不能小于黄色阈值')
  // W2 没有"提醒"一级
  const data = { remindHours: rule === 'W2' ? null : t.remindHours, yellowDays: t.yellowDays, redDays: t.redDays }
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
  if (input.role === 'DEPT_HEAD' && !department) throw new FlowError('部门负责人要填写部门名称')
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
