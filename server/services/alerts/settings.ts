/** 设置页（仅管理员）：阈值、停工日、通知对象、工单项目经理。 */
import type { NotifyRoleKind } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { FlowError } from '../flow/errors'
import { loadNames } from '../flow/names'
import { type RuleThreshold, type ScanRule, dateFieldDay } from './rules'
import { SCAN_RULES, loadThresholds } from './scan'

export async function getSettings() {
  const [thresholds, offDays, roles, workOrders, exts, depts] = await Promise.all([
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
  ])
  const names = await loadNames({ user: [...roles.map((r) => r.userId), ...exts.map((e) => e.projectManagerId)] })
  const pm = new Map(exts.map((e) => [e.workOrderNumber, e.projectManagerId]))
  return {
    thresholds: SCAN_RULES.map((rule) => ({ rule, ...thresholds[rule] })),
    offDays: offDays.map((d) => dateFieldDay(d.date)),
    // 部门负责人按部门名称配置（用户的部门 ID 经 qms_department 换成名称后对应），下拉给出 QMS 部门名称；
    // 已配置但部门已不在的名称也列出，免得编辑时丢失
    departments: [...new Set([...depts.map((d) => d.name), ...roles.map((r) => r.department)].filter((x): x is string => !!x))].sort(),
    roles: roles.map((r) => ({ ...r, userName: names.user.get(r.userId) ?? r.userId })),
    workOrders: workOrders.map((w) => {
      const id = pm.get(w.workOrderNumber) ?? null
      return { ...w, projectManagerId: id, projectManagerName: id ? (names.user.get(id) ?? id) : null }
    }),
  }
}

export async function saveThreshold(rule: ScanRule, t: RuleThreshold) {
  if (t.redDays < t.yellowDays) throw new FlowError('红色阈值不能小于黄色阈值')
  const noRemind = rule === 'W2' || rule === 'W4'
  if (!noRemind && t.remindHours == null) throw new FlowError('W1、W3、W5、W6 必须设置提醒阈值')
  // W2、W4 没有"提醒"一级
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
