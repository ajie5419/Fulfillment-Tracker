/**
 * 业务部门（权限方案 R13 第一节）：用户的 QMS 部门 → 6 个业务部门之一，全仓只在这里换算。
 *
 *   1. 本部门在 dept_mapping 里有对照 → 对照的业务部门；
 *   2. 没有时沿 parentId 向上找最近有对照的上级（班组、科室挂在大部门下面的情况）；
 *   3. 都没有时退回 QMS 部门名称本身（部门名正好叫"生产部"等的，和没有对照表之前一样生效）。
 *
 * 部门负责人（notify_role.department）、异常默认责任部门、预警升级里的"责任部门负责人"都用这里换算出的名称比对。
 * 显示给人看的"所在部门"仍用 QMS 原名称（flow/names.ts 的 userDepartmentNames）。
 */
import type { BusinessDept } from '@prisma/client'
import { prisma } from '../../utils/prisma'

export type { BusinessDept }

/** 业务部门显示名（与各服务里的 TECH_DEPT / PURCHASE_DEPT / PRODUCTION_DEPT 等常量一致） */
export const BUSINESS_DEPT_NAME: Record<BusinessDept, string> = {
  TECH: '技术部',
  PURCHASE: '采购部',
  PRODUCTION: '生产部',
  QUALITY: '质量部',
  FINANCE: '财务部',
  PROJECT: '项目部',
}

export const BUSINESS_DEPTS = Object.keys(BUSINESS_DEPT_NAME) as BusinessDept[]
export const BUSINESS_DEPT_NAMES = Object.values(BUSINESS_DEPT_NAME)

/** 名称 → 业务部门（不是 6 个之一的返回 null，算"其他"） */
export function businessDeptOfName(name: string | null | undefined): BusinessDept | null {
  if (!name) return null
  return BUSINESS_DEPTS.find((d) => BUSINESS_DEPT_NAME[d] === name) ?? null
}

/** 向上找上级时最多走几层（防止数据成环或层级异常时死循环） */
export const MAX_DEPT_DEPTH = 10

export interface DeptNode {
  name: string
  parentId: string | null
  /** QMS 已删除（历史数据仍能换算，但不再作为默认责任部门） */
  isDeleted?: boolean
}

/** 换算用的部门树 + 对照表（部门表不大，一次全读） */
export interface DeptIndex {
  depts: Map<string, DeptNode>
  mapping: Map<string, BusinessDept>
}

/**
 * 部门 ID → 用于比对的部门名称（纯函数）：有对照（本部门或最近的上级）时是业务部门名，否则是 QMS 部门名称本身。
 * 部门不在 depts 里（未同步）且没有对照时返回 null。
 */
export function resolveDeptName(deptId: string | null | undefined, index: DeptIndex): string | null {
  if (!deptId) return null
  const seen = new Set<string>()
  let cur: string | null = deptId
  for (let depth = 0; cur && depth <= MAX_DEPT_DEPTH && !seen.has(cur); depth++) {
    seen.add(cur)
    const mapped = index.mapping.get(cur)
    if (mapped) return BUSINESS_DEPT_NAME[mapped]
    cur = index.depts.get(cur)?.parentId ?? null
  }
  return index.depts.get(deptId)?.name ?? null
}

/** 部门 ID → 业务部门（纯函数）：换算出的名称是 6 个之一时返回，否则 null（"其他"） */
export function resolveBusinessDept(deptId: string | null | undefined, index: DeptIndex): BusinessDept | null {
  return businessDeptOfName(resolveDeptName(deptId, index))
}

/** 换算后名称等于 name 的全部 QMS 部门 ID（"本部门"筛选、按业务部门找默认责任部门用） */
export function deptIdsResolvingTo(name: string, index: DeptIndex): string[] {
  return [...index.depts.keys()].filter((id) => resolveDeptName(id, index) === name)
}

/**
 * 业务部门名称 → 作为"责任部门"记在异常上的 QMS 部门 ID（纯函数）：
 * 先找名称正好相同、且换算结果也是它的部门（与没有对照表之前一致）；再找直接对照到它的部门（取上级最少、ID 最小的）。
 * 已删除的部门不选。都没有时 null。
 */
export function representativeDeptId(name: string, index: DeptIndex): string | null {
  const alive = [...index.depts.entries()].filter(([, d]) => !d.isDeleted)
  const sameName = alive.filter(([id, d]) => d.name === name && resolveDeptName(id, index) === name).map(([id]) => id).sort()
  if (sameName.length) return sameName[0]!
  const biz = businessDeptOfName(name)
  if (!biz) return null
  const depth = (id: string) => {
    let n = 0
    for (let cur = index.depts.get(id)?.parentId ?? null; cur && index.depts.has(cur) && n < MAX_DEPT_DEPTH; cur = index.depts.get(cur)?.parentId ?? null) n++
    return n
  }
  const mapped = alive.filter(([id]) => index.mapping.get(id) === biz).map(([id]) => id)
  mapped.sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0))
  return mapped[0] ?? null
}

/** 读部门树和对照表。含已删除的部门：历史异常上的责任部门仍能换算 */
export async function loadDeptIndex(): Promise<DeptIndex> {
  const [depts, mapping] = await Promise.all([
    prisma.qmsDepartment.findMany({ select: { id: true, name: true, parentId: true, isDeleted: true } }),
    prisma.deptMapping.findMany(),
  ])
  return {
    depts: new Map(depts.map((d) => [d.id, { name: d.name, parentId: d.parentId || null, isDeleted: d.isDeleted }])),
    mapping: new Map(mapping.map((m) => [m.qmsDepartmentId, m.businessDept])),
  }
}

/** 部门 ID → 用于比对的部门名称（批量） */
export async function resolveDeptNames(deptIds: (string | null | undefined)[], index?: DeptIndex): Promise<Map<string, string>> {
  const ids = [...new Set(deptIds.filter((x): x is string => !!x))]
  if (!ids.length) return new Map()
  const idx = index ?? (await loadDeptIndex())
  const out = new Map<string, string>()
  for (const id of ids) {
    const name = resolveDeptName(id, idx)
    if (name) out.set(id, name)
  }
  return out
}

/** 用户 → 用于比对的部门名称（批量）。没有部门或部门找不到的用户不在结果里 */
export async function userDeptNames(userIds: (string | null | undefined)[], index?: DeptIndex): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))]
  if (!ids.length) return new Map()
  const [users, idx] = await Promise.all([
    prisma.qmsUser.findMany({ where: { id: { in: ids } }, select: { id: true, departmentId: true } }),
    index ? Promise.resolve(index) : loadDeptIndex(),
  ])
  const out = new Map<string, string>()
  for (const u of users) {
    const name = resolveDeptName(u.departmentId, idx)
    if (name) out.set(u.id, name)
  }
  return out
}

/** 一个用户的业务部门（没有对上的为 null，算"其他"） */
export async function userBusinessDept(userId: string): Promise<BusinessDept | null> {
  return businessDeptOfName((await userDeptNames([userId])).get(userId))
}
